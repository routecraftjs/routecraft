import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  folder,
  file,
  only,
  type FolderEntry,
} from "@routecraft/routecraft";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("Folder Adapter - Source", () => {
  let t: TestContext | undefined;
  let tmpDir: string;

  beforeEach(async () => {
    t = undefined;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "folder-test-"));
  });

  afterEach(async () => {
    if (t) {
      await t.stop();
      t = undefined;
    }
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * @case Default (non-chunked) emits the whole listing as one exchange
   * @preconditions Directory with three files exists
   * @expectedResult One exchange whose body is a sorted FolderEntry[]
   */
  test("non-chunked emits the listing as a single array exchange", async () => {
    await fsp.writeFile(path.join(tmpDir, "a.txt"), "aaa", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "b.txt"), "bbb", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "c.txt"), "ccc", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-array")
          .from(folder({ path: tmpDir }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const entries = s.received[0].body as FolderEntry[];
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  /**
   * @case Chunked mode emits one exchange per file
   * @preconditions Directory with three files exists
   * @expectedResult Three exchanges, one per file, sorted by relative path
   */
  test("chunked emits one exchange per file", async () => {
    await fsp.writeFile(path.join(tmpDir, "a.txt"), "aaa", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "b.txt"), "bbb", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "c.txt"), "ccc", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-chunked")
          .from(folder({ path: tmpDir, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(3);
    const names = (s.received as { body: FolderEntry }[]).map(
      (e) => e.body.name,
    );
    expect(names).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  /**
   * @case Each entry carries file metadata
   * @preconditions Directory with a single known file exists
   * @expectedResult Body has path, name, ext, size, relativePath, and dates
   */
  test("entry carries metadata", async () => {
    const filePath = path.join(tmpDir, "report.JSON");
    await fsp.writeFile(filePath, "12345", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-meta")
          .from(folder({ path: tmpDir, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const entry = (s.received[0] as { body: FolderEntry }).body;
    expect(entry.path).toBe(filePath);
    expect(entry.name).toBe("report.JSON");
    // Extension is lowercased for predictable filtering.
    expect(entry.ext).toBe(".json");
    expect(entry.dir).toBe(tmpDir);
    expect(entry.relativePath).toBe("report.JSON");
    expect(entry.size).toBe(5);
    expect(entry.isDirectory).toBe(false);
    expect(entry.modifiedAt).toBeInstanceOf(Date);
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  /**
   * @case Directories are skipped by default
   * @preconditions Directory contains one file and one subdirectory
   * @expectedResult Only the file is listed
   */
  test("skips directories by default", async () => {
    await fsp.writeFile(path.join(tmpDir, "file.txt"), "x", "utf-8");
    await fsp.mkdir(path.join(tmpDir, "subdir"));

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-skip-dirs")
          .from(folder({ path: tmpDir, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    expect((s.received[0] as { body: FolderEntry }).body.name).toBe("file.txt");
  });

  /**
   * @case includeDirs emits directory entries too
   * @preconditions Directory contains one file and one subdirectory
   * @expectedResult Both the file and the directory are listed
   */
  test("includeDirs emits directory entries", async () => {
    await fsp.writeFile(path.join(tmpDir, "file.txt"), "x", "utf-8");
    await fsp.mkdir(path.join(tmpDir, "subdir"));

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-include-dirs")
          .from(folder({ path: tmpDir, includeDirs: true, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(2);
    const entries = (s.received as { body: FolderEntry }[]).map((e) => e.body);
    const dir = entries.find((e) => e.name === "subdir");
    expect(dir?.isDirectory).toBe(true);
  });

  /**
   * @case Recursive scan descends into subdirectories
   * @preconditions Nested directories each contain a file
   * @expectedResult Files at every depth are listed with correct relativePath
   */
  test("recursive scan descends into subdirectories", async () => {
    await fsp.writeFile(path.join(tmpDir, "top.txt"), "1", "utf-8");
    await fsp.mkdir(path.join(tmpDir, "nested"));
    await fsp.writeFile(path.join(tmpDir, "nested", "deep.txt"), "2", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-recursive")
          .from(folder({ path: tmpDir, recursive: true, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    const relPaths = (s.received as { body: FolderEntry }[])
      .map((e) => e.body.relativePath)
      .sort();
    expect(relPaths).toEqual([path.join("nested", "deep.txt"), "top.txt"]);
  });

  /**
   * @case Non-recursive scan ignores nested files
   * @preconditions A nested directory contains a file
   * @expectedResult Only the top-level entries are listed (nested file absent)
   */
  test("non-recursive scan ignores nested files", async () => {
    await fsp.writeFile(path.join(tmpDir, "top.txt"), "1", "utf-8");
    await fsp.mkdir(path.join(tmpDir, "nested"));
    await fsp.writeFile(path.join(tmpDir, "nested", "deep.txt"), "2", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-flat-only")
          .from(folder({ path: tmpDir, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    const names = (s.received as { body: FolderEntry }[]).map(
      (e) => e.body.name,
    );
    expect(names).toEqual(["top.txt"]);
  });

  /**
   * @case Empty directory: non-chunked emits one empty-array exchange
   * @preconditions An empty directory exists
   * @expectedResult One exchange whose body is an empty array
   */
  test("empty directory emits one empty-array exchange (non-chunked)", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-empty-array")
          .from(folder({ path: tmpDir }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual([]);
  });

  /**
   * @case Empty directory: chunked emits nothing
   * @preconditions An empty directory exists
   * @expectedResult No exchanges are emitted
   */
  test("empty directory emits nothing (chunked)", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-empty-chunked")
          .from(folder({ path: tmpDir, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(0);
  });

  /**
   * @case Chunked: filter by extension then read content with the file adapter
   * @preconditions Directory has a .json file and a .txt file
   * @expectedResult Only the .json file's content is read and reaches the spy
   */
  test("chunked filter then enrich with file content", async () => {
    await fsp.writeFile(path.join(tmpDir, "keep.json"), '{"ok":true}', "utf-8");
    await fsp.writeFile(path.join(tmpDir, "skip.txt"), "ignored", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-filter-read")
          .from(folder({ path: tmpDir, chunked: true }))
          .filter((ex) => ex.body.ext === ".json")
          .enrich(
            file({
              path: (ex) => (ex.body as FolderEntry).path,
              mode: "read",
            }),
            only((content: string) => content, "content"),
          )
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const body = s.received[0].body as FolderEntry & { content: string };
    expect(body.name).toBe("keep.json");
    expect(body.content).toBe('{"ok":true}');
  });

  /**
   * @case Non-chunked: transform + split the listing, then read each file
   * @preconditions Directory has a .json file and a .txt file
   * @expectedResult Only the .json file is split out and its content read
   */
  test("non-chunked transform then split then read", async () => {
    await fsp.writeFile(path.join(tmpDir, "keep.json"), '{"ok":true}', "utf-8");
    await fsp.writeFile(path.join(tmpDir, "skip.txt"), "ignored", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-split-read")
          .from(folder({ path: tmpDir }))
          .transform((entries) => entries.filter((e) => e.ext === ".json"))
          .split((ex) => ex.body)
          .enrich(
            file({
              path: (ex) => (ex.body as FolderEntry).path,
              mode: "read",
            }),
            only((content: string) => content, "content"),
          )
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const body = s.received[0].body as FolderEntry & { content: string };
    expect(body.name).toBe("keep.json");
    expect(body.content).toBe('{"ok":true}');
  });

  /**
   * @case Aborting mid-stream stops chunked emission
   * @preconditions Directory with many files; route aborts after a few
   * @expectedResult Fewer exchanges than total files are received
   */
  test("abort mid-stream stops chunked emitting", async () => {
    for (let i = 0; i < 50; i++) {
      await fsp.writeFile(
        path.join(tmpDir, `f${String(i).padStart(3, "0")}.txt`),
        "x",
        "utf-8",
      );
    }

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("folder-abort")
          .from(folder({ path: tmpDir, chunked: true }))
          .process(async (exchange) => {
            if (s.received.length >= 2) {
              t!.ctx.stop();
            }
            return exchange;
          })
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received.length).toBeGreaterThanOrEqual(1);
    expect(s.received.length).toBeLessThan(50);
  });

  /**
   * @case Throws a clear error for a non-existent directory
   * @preconditions Path points to a directory that does not exist
   * @expectedResult subscribe rejects with "directory not found"
   */
  test("throws for non-existent directory", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    const adapter = folder({ path: missing });

    await expect(
      adapter.subscribe({
        context: {} as never,
        signal: new AbortController().signal,
        meta: { routeId: "test" },
        ready: () => {},
        complete: () => {},
        emit: async () => ({}) as never,
      }),
    ).rejects.toThrow(/directory not found/);
  });
});
