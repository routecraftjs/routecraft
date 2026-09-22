import { spawn as spawnProcess } from "bun";
import { test, expect } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRecords } from "../../src/v2/index.ts";
const script = new URL("../../validation/round-two/process.ts", import.meta.url)
  .pathname;
const read = (dir: string, name: string) =>
  JSON.parse(readFileSync(join(dir, name), "utf8"));
async function waitFor(path: string) {
  const end = Date.now() + 5000;
  while (!existsSync(path)) {
    if (Date.now() > end) throw Error(`timeout ${path}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
function spawn(mode: string, dir: string, arg = "") {
  return spawnProcess([process.execPath, script, mode, dir, arg], {
    stdout: "pipe",
    stderr: "pipe",
  });
}
async function success(child: ReturnType<typeof spawn>) {
  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
}
/**
 * @case actual restart
 * @preconditions child parks nested reentrant agent and is killed
 * @expectedResult new PID resumes suffix once as the restored parked identity with the resumer recorded as data, a downstream gate refuses it, prefix/tool request once, a repeat is a duplicate, two stores retain conversation */
test("defer → SIGKILL → new process → resume named nested instruction across two stores", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routecraft-restart-"));
  const child = spawn("park", dir);
  try {
    await waitFor(join(dir, "parked.json"));
    const parked = read(dir, "parked.json");
    expect(parked.result.status).toBe("deferred");
    expect(readFileSync(join(dir, "effects.log"), "utf8")).toBe(
      "prefix\ntool-request\n",
    );
    expect(parked.session.value.phase).toBe("awaiting");
    child.kill("SIGKILL");
    await child.exited;
    await success(spawn("mismatch", dir));
    const mismatch = read(dir, "mismatch.txt");
    expect(mismatch.error).toContain("PLAN_MISMATCH");
    // The edited plan settles the record it was tried on as denied; the real approval is untouched.
    expect(mismatch.copy.state).toBe("denied");
    expect(mismatch.original.state).toBe("waiting");
    expect(mismatch.original.claimedAt).toBeUndefined();
    expect(parked.id).toMatch(/#1$/);
    await success(spawn("resume", dir));
    const resumed = read(dir, "resumed.json");
    expect(resumed.pid).not.toBe(parked.pid);
    expect(resumed.result.status).toBe("completed");
    // The same approval presented twice is answered from the cache; the suffix ran once.
    expect(resumed.again.status).toBe("duplicate");
    expect(resumed.session.value.messages).toEqual([
      "user:book",
      "assistant:tool-request",
      "tool:approved",
      "assistant:done",
    ]);
    expect(resumed.waiting).toEqual([]);
    expect(readFileSync(join(dir, "effects.log"), "utf8")).toBe(
      "prefix\ntool-request\ntool-result\nsuffix\nprincipal:alice:restored\nresumedBy:bob:restored\nsink:refused\n",
    );
  } finally {
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
/**
 * @case power-loss model
 * @preconditions SIGKILL exactly between primary and index statements
 * @expectedResult neither durable row survives; later atomic commit retains both */
test("SIGKILL between record and index statements rolls back both", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routecraft-crash-"));
  try {
    const child = spawn("crash", dir);
    await child.exited;
    expect(existsSync(join(dir, "between-writes"))).toBe(true);
    expect(child.exitCode).not.toBe(0);
    const store = new SqliteRecords(join(dir, "crash.db"));
    expect(store.keys("")).toEqual([]);
    store.write([
      { key: "record/x", value: 1 },
      { key: "waiting/x", value: null },
    ]);
    store.close();
    const reopened = new SqliteRecords(join(dir, "crash.db"));
    expect(reopened.keys("")).toEqual(["record/x", "waiting/x"]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
/**
 * @case real CAS race
 * @preconditions two processes read same version then pass barrier together
 * @expectedResult exactly one writer wins */
test("CAS under overlapping processes sharing the same observed version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routecraft-cas-"));
  let a: ReturnType<typeof spawn> | undefined,
    b: ReturnType<typeof spawn> | undefined;
  try {
    const s = new SqliteRecords(join(dir, "cas.db"));
    s.write([{ key: "latch", value: "initial" }]);
    s.close();
    a = spawn("cas", dir, "a");
    b = spawn("cas", dir, "b");
    await Promise.all([
      waitFor(join(dir, "ready-a")),
      waitFor(join(dir, "ready-b")),
    ]);
    expect(readFileSync(join(dir, "ready-a"), "utf8")).not.toBe(
      readFileSync(join(dir, "ready-b"), "utf8"),
    );
    writeFileSync(join(dir, "go"), "go");
    await Promise.all([success(a), success(b)]);
    expect(
      ["a", "b"].map((x) => readFileSync(join(dir, `won-${x}`), "utf8")).sort(),
    ).toEqual(["false", "true"]);
  } finally {
    a?.kill();
    b?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
