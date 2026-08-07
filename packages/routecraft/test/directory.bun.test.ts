import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  testContext,
  testSubscription,
  spy,
  type TestContext,
} from "@routecraft/testing";
import {
  craft,
  directory,
  file,
  only,
  simple,
  type DirectoryEntry,
  type DirectoryAdapter,
  type Exchange,
} from "@routecraft/routecraft";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("Directory Adapter - Source", () => {
  let t: TestContext | undefined;
  let tmpDir: string;

  beforeEach(async () => {
    t = undefined;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "directory-test-"));
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
   * @expectedResult One exchange whose body is a sorted DirectoryEntry[]
   */
  test("non-chunked emits the listing as a single array exchange", async () => {
    await fsp.writeFile(path.join(tmpDir, "a.txt"), "aaa", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "b.txt"), "bbb", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "c.txt"), "ccc", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-array")
          .from(directory({ path: tmpDir }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const entries = s.received[0].body as DirectoryEntry[];
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
          .id("directory-chunked")
          .from(directory({ path: tmpDir, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(3);
    const names = (s.received as { body: DirectoryEntry }[]).map(
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
          .id("directory-meta")
          .from(directory({ path: tmpDir, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const entry = (s.received[0] as { body: DirectoryEntry }).body;
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
          .id("directory-skip-dirs")
          .from(directory({ path: tmpDir, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    expect((s.received[0] as { body: DirectoryEntry }).body.name).toBe(
      "file.txt",
    );
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
          .id("directory-include-dirs")
          .from(directory({ path: tmpDir, includeDirs: true, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(2);
    const entries = (s.received as { body: DirectoryEntry }[]).map(
      (e) => e.body,
    );
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
          .id("directory-recursive")
          .from(directory({ path: tmpDir, recursive: true, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    const relPaths = (s.received as { body: DirectoryEntry }[])
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
          .id("directory-flat-only")
          .from(directory({ path: tmpDir, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    const names = (s.received as { body: DirectoryEntry }[]).map(
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
          .id("directory-empty-array")
          .from(directory({ path: tmpDir }))
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
          .id("directory-empty-chunked")
          .from(directory({ path: tmpDir, chunked: true }))
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
          .id("directory-filter-read")
          .from(directory({ path: tmpDir, chunked: true }))
          .filter((ex) => ex.body.ext === ".json")
          .enrich(
            file({
              path: (ex) => (ex.body as DirectoryEntry).path,
            }),
            only((content: string) => content, "content"),
          )
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const body = s.received[0].body as DirectoryEntry & { content: string };
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
          .id("directory-split-read")
          .from(directory({ path: tmpDir }))
          .transform((entries) => entries.filter((e) => e.ext === ".json"))
          .split((ex) => ex.body)
          .enrich(
            file({
              path: (ex) => (ex.body as DirectoryEntry).path,
            }),
            only((content: string) => content, "content"),
          )
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const body = s.received[0].body as DirectoryEntry & { content: string };
    expect(body.name).toBe("keep.json");
    expect(body.content).toBe('{"ok":true}');
  });

  /**
   * @case A symlink pointing at a directory is skipped by default (regression)
   * @preconditions A real subdirectory, a symlink to it, and a plain file exist
   * @expectedResult Only the plain file is emitted; the symlinked directory,
   *   whose type is resolved by following the link, is treated as a directory
   *   and skipped when includeDirs is false
   */
  test("symlink to a directory is skipped by default", async () => {
    await fsp.mkdir(path.join(tmpDir, "realdir"));
    await fsp.writeFile(path.join(tmpDir, "keep.txt"), "x", "utf-8");
    await fsp.symlink(
      path.join(tmpDir, "realdir"),
      path.join(tmpDir, "linkdir"),
    );

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-symlink-skip")
          .from(directory({ path: tmpDir, chunked: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    const names = (s.received as { body: DirectoryEntry }[]).map(
      (e) => e.body.name,
    );
    expect(names).toEqual(["keep.txt"]);
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
          .id("directory-abort")
          .from(directory({ path: tmpDir, chunked: true }))
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
    const adapter = directory({ path: missing });

    t = await testContext().build();

    await expect(
      adapter.subscribe(
        testSubscription({ context: t.ctx, handler: () => undefined }),
      ),
    ).rejects.toThrow(/directory not found/);
  });

  /**
   * @case The source role rejects a dynamic (function) path at runtime
   * @preconditions Adapter built with a function path, used via .from(); the
   *   shape is legal for the enricher role, so only the source guard fires
   * @expectedResult subscribe rejects, pointing at the enricher role
   */
  test("source rejects a dynamic (function) path", async () => {
    const adapter = directory({ path: () => tmpDir });

    t = await testContext().build();

    await expect(
      adapter.subscribe(
        testSubscription({ context: t.ctx, handler: () => undefined }),
      ),
    ).rejects.toThrow(/the source role requires a static string path/);
  });
});

describe("Directory Adapter - Enricher (list mid-route)", () => {
  let t: TestContext | undefined;
  let tmpDir: string;

  beforeEach(async () => {
    t = undefined;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "directory-fetch-test-"));
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
   * @case .to() resolves the fetch (no send exists), so the listing becomes
   *   the body: a directory can be listed mid-route, e.g. in a capability
   * @preconditions Directory with three files exists
   * @expectedResult The body becomes the sorted DirectoryEntry[] listing
   */
  test("to() replaces the body with the listing", async () => {
    await fsp.writeFile(path.join(tmpDir, "b.txt"), "bbb", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "a.txt"), "aaa", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "c.txt"), "ccc", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-fetch-to")
          .from(simple("ignored"))
          .to(directory({ path: tmpDir }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const entries = s.received[0].body as DirectoryEntry[];
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  /**
   * @case .enrich() with an aggregator merges the listing alongside the body
   * @preconditions Directory with one file; body carries an unrelated field
   * @expectedResult The original body survives with the listing merged in
   */
  test("enrich merges the listing with an aggregator", async () => {
    await fsp.writeFile(path.join(tmpDir, "only.txt"), "x", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-fetch-enrich")
          .from(simple({ query: "notes" }))
          .enrich(
            directory({ path: tmpDir }),
            only((entries: DirectoryEntry[]) => entries, "candidates"),
          )
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const body = s.received[0].body as {
      query: string;
      candidates: DirectoryEntry[];
    };
    expect(body.query).toBe("notes");
    expect(body.candidates.map((e) => e.name)).toEqual(["only.txt"]);
  });

  /**
   * @case The enricher resolves a dynamic (function) path from the exchange,
   *   which the source role rejects
   * @preconditions Body carries the directory name; path is a function of it
   * @expectedResult The directory selected by the body is listed
   */
  test("supports a dynamic (function) path", async () => {
    const sub = path.join(tmpDir, "picked");
    await fsp.mkdir(sub);
    await fsp.writeFile(path.join(sub, "inside.txt"), "x", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-fetch-dynamic")
          .from(simple<{ dir: string }>({ dir: sub }))
          .to(directory({ path: (ex) => (ex.body as { dir: string }).dir }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const entries = s.received[0].body as DirectoryEntry[];
    expect(entries.map((e) => e.name)).toEqual(["inside.txt"]);
  });

  /**
   * @case Recursive fetch descends into subdirectories
   * @preconditions Nested directories each contain a file
   * @expectedResult Files at every depth appear with correct relativePath
   */
  test("recursive scan descends into subdirectories", async () => {
    await fsp.writeFile(path.join(tmpDir, "top.txt"), "1", "utf-8");
    await fsp.mkdir(path.join(tmpDir, "nested"));
    await fsp.writeFile(path.join(tmpDir, "nested", "deep.txt"), "2", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-fetch-recursive")
          .from(simple("go"))
          .to(directory({ path: tmpDir, recursive: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    const entries = s.received[0].body as DirectoryEntry[];
    expect(entries.map((e) => e.relativePath).sort()).toEqual([
      path.join("nested", "deep.txt"),
      "top.txt",
    ]);
  });

  /**
   * @case includeDirs lists directory entries too in the enricher role
   * @preconditions Directory contains one file and one subdirectory
   * @expectedResult Both appear, and the directory is flagged isDirectory
   */
  test("includeDirs lists directory entries", async () => {
    await fsp.writeFile(path.join(tmpDir, "file.txt"), "x", "utf-8");
    await fsp.mkdir(path.join(tmpDir, "subdir"));

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-fetch-include-dirs")
          .from(simple("go"))
          .to(directory({ path: tmpDir, includeDirs: true }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    const entries = s.received[0].body as DirectoryEntry[];
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.name === "subdir")?.isDirectory).toBe(true);
  });

  /**
   * @case An empty directory fetches an empty array, not an error
   * @preconditions An empty directory exists
   * @expectedResult The body becomes an empty DirectoryEntry[]
   */
  test("empty directory fetches an empty array", async () => {
    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-fetch-empty")
          .from(simple("go"))
          .to(directory({ path: tmpDir }))
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    expect(s.received[0].body).toEqual([]);
  });

  /**
   * @case A missing directory rejects through the shared error mapping
   * @preconditions Path points to a directory that does not exist
   * @expectedResult fetch rejects with "directory not found"
   */
  test("throws for non-existent directory", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    const adapter = directory({ path: missing });

    await expect(
      adapter.fetch({ body: undefined, headers: {} } as unknown as Exchange),
    ).rejects.toThrow(/directory not found/);
  });

  /**
   * @case An aborted scan throws instead of returning a partial listing
   * @preconditions Directory has files; fetch runs with an already-aborted
   *   signal, as an enclosing .timeout() would supply
   * @expectedResult fetch rejects with the RC5011 timeout code rather than
   *   resolving with a truncated listing indistinguishable from a complete one
   */
  test("throws when the scan is aborted rather than returning a partial listing", async () => {
    await fsp.writeFile(path.join(tmpDir, "a.txt"), "a", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "b.txt"), "b", "utf-8");

    const adapter = directory({ path: tmpDir });
    const controller = new AbortController();
    controller.abort();

    const fetching = adapter.fetch(
      { body: undefined, headers: {} } as unknown as Exchange,
      { signal: controller.signal },
    );

    await expect(fetching).rejects.toThrow(/aborted before completion/);
    // Classified as a timeout, matching what the timeout wrapper itself
    // throws, so .error() handlers and retry policy can act on the code.
    await expect(fetching).rejects.toMatchObject({ rc: "RC5011" });
  });

  /**
   * @case The enricher's listing is identical to the source's for the same
   *   options, since both delegate to the shared scan
   * @preconditions A tree with nested files, a subdirectory, and mixed
   *   extensions; both roles scan it with recursive and includeDirs enabled
   * @expectedResult The fetched DirectoryEntry[] deep-equals the source's
   *   emitted body, including order
   */
  test("parity: enricher listing equals source listing", async () => {
    await fsp.writeFile(path.join(tmpDir, "b.md"), "b", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "a.txt"), "a", "utf-8");
    await fsp.mkdir(path.join(tmpDir, "sub"));
    await fsp.writeFile(path.join(tmpDir, "sub", "deep.json"), "{}", "utf-8");

    const options = { path: tmpDir, recursive: true, includeDirs: true };
    const fromSource = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-parity-source")
          .from(directory(options))
          .to(fromSource),
      )
      .build();

    await t.ctx.start();

    const adapter: DirectoryAdapter = directory(options);
    const fetched = await adapter.fetch({
      body: undefined,
      headers: {},
    } as unknown as Exchange);

    expect(fromSource.received).toHaveLength(1);
    const sourceEntries = fromSource.received[0].body as DirectoryEntry[];
    expect(fetched).toEqual(sourceEntries);
    expect(fetched.map((e) => e.relativePath)).toEqual([
      "a.txt",
      "b.md",
      "sub",
      path.join("sub", "deep.json"),
    ]);
  });

  /**
   * @case The enricher role survives `chunked: true` and still fetches the
   *   whole listing: chunked is a source-only emission shape, so it must not
   *   strip the fetch slot from the runtime object (regression guard for
   *   declared-type-vs-runtime-slot drift)
   * @preconditions Directory with two files; adapter built with chunked
   * @expectedResult .enrich() fetches the full DirectoryEntry[], not one entry
   */
  test("chunked keeps the enricher role and fetches the whole listing", async () => {
    await fsp.writeFile(path.join(tmpDir, "a.txt"), "a", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "b.txt"), "b", "utf-8");

    const chunkedAdapter = directory({ path: tmpDir, chunked: true });
    expect(typeof chunkedAdapter.fetch).toBe("function");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-chunked-fetch")
          .from(simple({ q: "x" }))
          .enrich(
            chunkedAdapter,
            only((entries: DirectoryEntry[]) => entries, "listing"),
          )
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const body = s.received[0].body as { listing: DirectoryEntry[] };
    expect(body.listing.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
  });

  /**
   * @case The full capability shape: list, narrow, split, read each file
   * @preconditions A notes directory with one .md and one .txt file
   * @expectedResult Only the .md file flows through, with its content read
   */
  test("capability shape: list, filter, split, then read each file", async () => {
    await fsp.writeFile(path.join(tmpDir, "keep.md"), "# Keep", "utf-8");
    await fsp.writeFile(path.join(tmpDir, "skip.txt"), "ignored", "utf-8");

    const s = spy();

    t = await testContext()
      .routes(
        craft()
          .id("directory-capability")
          .from(simple("search"))
          .to(directory({ path: tmpDir, recursive: true }))
          .transform((entries) => entries.filter((e) => e.ext === ".md"))
          .split((ex) => ex.body)
          .enrich(
            file({ path: (ex) => (ex.body as DirectoryEntry).path }),
            only((content: string) => content, "content"),
          )
          .to(s),
      )
      .build();

    await t.ctx.start();

    expect(s.received).toHaveLength(1);
    const body = s.received[0].body as DirectoryEntry & { content: string };
    expect(body.name).toBe("keep.md");
    expect(body.content).toBe("# Keep");
  });
});
