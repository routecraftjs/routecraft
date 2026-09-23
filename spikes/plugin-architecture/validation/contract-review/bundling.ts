/* eslint-disable no-console -- Emitted callable evidence. */
import { build, write } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import {
  application,
  operations,
  deferral,
  sqlite,
  manual,
  CONTINUATIONS,
} from "../../src/v2/index.ts";
const temp = mkdtempSync(join(tmpdir(), "review-bundle-"));
try {
  const entry = join(temp, "entry.ts");
  const emit = async (name: string, minify: boolean, multiplier: number) => {
    writeFileSync(
      entry,
      `export const suffix = (amount: number) => { const adjusted = amount * ${multiplier}; return adjusted; };\n`,
    );
    const outfile = join(temp, name + ".js");
    const built = await build({
      entrypoints: [entry],
      target: "bun",
      minify,
    });
    if (!built.success) throw Error(String(built.logs));
    await write(outfile, built.outputs[0]!);
    return (await import(outfile)).suffix as (n: number) => number;
  };
  const plain = await emit("plain", false, 2),
    mini = await emit("mini", true, 2),
    same = await emit("same", true, 2),
    edit = await emit("edit", true, 3);
  assert.notEqual(String(plain), String(mini));
  assert.equal(String(mini), String(same));
  assert.notEqual(String(mini), String(edit));
  const run = async (
    first: (n: number) => number,
    second: (n: number) => number,
  ) => {
    const setup = async (fn: (n: number) => number) => {
      const app = application([operations, deferral, sqlite(":memory:")]);
      await app.start([
        app.route("r").from(manual).defer("a").transform(fn).build(),
      ]);
      return app;
    };
    const a = await setup(first),
      b = await setup(second);
    try {
      const id = (await a.runtime.deliver("r", 2)).deferrals[0]!;
      const c = (await a.host.service(CONTINUATIONS).get(id))!.continuation;
      await b.host.service(CONTINUATIONS).create(id, c);
      try {
        return (await b.runtime.resume(id)).status;
      } catch (e) {
        return String(e).includes("PLAN_MISMATCH")
          ? "PLAN_MISMATCH"
          : String(e);
      }
    } finally {
      await a.stop();
      await b.stop();
    }
  };
  for (const [name, a, b, expected] of [
    ["plain to minified", plain, mini, "PLAN_MISMATCH"],
    ["same minifier and input", mini, same, "completed"],
    ["edited minified callable", mini, edit, "PLAN_MISMATCH"],
  ] as const) {
    const observed = await run(a, b);
    assert.equal(observed, expected);
    console.log(`${name}: ${observed}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
