import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  directory,
  file,
  isRoutecraftError,
  jsonl,
  simple,
} from "@routecraft/routecraft";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  throwDirectoryError,
  throwFileError,
} from "../src/adapters/shared/fs-errors.ts";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function thrownBy(run: () => never): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
}

function errnoOf(err: unknown): string | undefined {
  for (let at: unknown = err; at instanceof Error; at = at.cause) {
    const code = (at as NodeJS.ErrnoException).code;
    if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return code;
  }
  return undefined;
}

describe("filesystem adapter errors", () => {
  let t: TestContext | undefined;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "fs-errors-test-"));
  });

  afterEach(async () => {
    if (t) await t.stop();
    t = undefined;
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * @case A route's .error() handler can tell a missing file by code
   * @preconditions .enrich(file()) on a path that does not exist, and one below a regular file
   * @expectedResult The handler sees RC5014 both times, with ENOENT and ENOTDIR on the cause chain
   */
  test("a missing file reaches .error() as RC5014 with the errno as cause", async () => {
    const regular = path.join(tmpDir, "regular.txt");
    await fsp.writeFile(regular, "x");
    const seen: { rc: string | undefined; errno: string | undefined }[] = [];
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("missing-file")
          .error((error) => {
            seen.push({
              rc: isRoutecraftError(error) ? error.rc : undefined,
              errno: errnoOf(error),
            });
            return "empty";
          })
          .from(
            simple([
              path.join(tmpDir, "absent.txt"),
              path.join(regular, "below.txt"),
            ]),
          )
          .enrich(file({ path: (ex) => String(ex.body) }))
          .to(s),
      )
      .build();
    await t.test();

    expect(seen).toEqual([
      { rc: "RC5014", errno: "ENOENT" },
      { rc: "RC5014", errno: "ENOTDIR" },
    ]);
  });

  /**
   * @case A missing source file fails the route with RC5014
   * @preconditions file() and jsonl() sources on paths that do not exist
   * @expectedResult context:error carries RC5014 with the unchanged "file not found" message
   */
  test("a missing source file is RC5014 for file and jsonl", async () => {
    const errors: unknown[] = [];
    t = await testContext()
      .on("context:error", ({ details }) => {
        errors.push(details.error);
      })
      .routes([
        craft()
          .id("file-source")
          .from(file({ path: path.join(tmpDir, "a.txt") }))
          .to(spy()),
        craft()
          .id("jsonl-source")
          .from(jsonl({ path: path.join(tmpDir, "a.jsonl") }))
          .to(spy()),
      ])
      .build();
    await t.ctx.start();
    await new Promise((r) => setTimeout(r, 20));

    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(isRoutecraftError(error) && error.rc).toBe("RC5014");
      expect((error as Error).message).toMatch(/adapter: file not found: /);
      expect(errnoOf(error)).toBe("ENOENT");
    }
  });

  /**
   * @case A missing directory and a path that is not a directory are RC5014
   * @preconditions .enrich(directory()) on an absent path and on a regular file
   * @expectedResult The handler sees RC5014 for both
   */
  test("directory() reports a missing or wrong-kind path as RC5014", async () => {
    const regular = path.join(tmpDir, "regular.txt");
    await fsp.writeFile(regular, "x");
    const seen: (string | undefined)[] = [];

    t = await testContext()
      .routes(
        craft()
          .id("missing-directory")
          .error((error) => {
            seen.push(isRoutecraftError(error) ? error.rc : undefined);
            return "empty";
          })
          .from(simple([path.join(tmpDir, "absent"), regular]))
          .enrich(directory({ path: (ex) => String(ex.body) }))
          .to(spy()),
      )
      .build();
    await t.test();

    expect(seen).toEqual(["RC5014", "RC5014"]);
  });

  /**
   * @case EACCES is RC5015 and any other failure keeps its errno as cause
   * @preconditions throwFileError and throwDirectoryError given simulated errno errors
   * @expectedResult RC5015 for EACCES; a plain Error with the original as cause for EISDIR
   */
  test("permission denied is RC5015 and other failures carry the cause", () => {
    for (const run of [
      () => throwFileError("file", "/p", errno("EACCES")),
      () => throwDirectoryError("directory", "/p", errno("EACCES")),
    ]) {
      const denied = thrownBy(run);
      expect(isRoutecraftError(denied) && denied.rc).toBe("RC5015");
      expect((denied as Error).message).toMatch(/permission denied reading/);
      expect(errnoOf(denied)).toBe("EACCES");
    }

    const other = thrownBy(() => throwFileError("csv", "/p", errno("EISDIR")));
    expect(isRoutecraftError(other)).toBe(false);
    expect((other as Error).message).toMatch(
      /csv adapter: failed to read file/,
    );
    expect(errnoOf(other)).toBe("EISDIR");
  });
});
