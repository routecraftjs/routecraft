/* eslint-disable no-console -- Compiler evidence for the validation report. */
import { spawn } from "bun";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
const compiler = resolve(root, "../../node_modules/typescript/bin/tsc");
const base = [
  process.execPath,
  compiler,
  "--noEmit",
  "--strict",
  "--skipLibCheck",
  "--module",
  "preserve",
  "--moduleResolution",
  "bundler",
  "--target",
  "ES2022",
  "--types",
  "bun-types",
  "--allowImportingTsExtensions",
];
async function check(path: string) {
  const p = spawn([...base, path], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await p.exited,
    output:
      (await new Response(p.stdout).text()) +
      (await new Response(p.stderr).text()),
  };
}
const original = readFileSync(resolve(root, "src/v2/types.check.ts"), "utf8");
const markers = [...original.matchAll(/\/\/ @ts-expect-error[^\n]*/g)];
const temp = resolve(import.meta.dir, "negative.check.ts");
try {
  const baseline = await check("src/v2/types.check.ts");
  if (baseline.code) throw Error(baseline.output);
  for (const marker of markers) {
    const changed =
      original.slice(0, marker.index) +
      original.slice(marker.index! + marker[0].length);
    writeFileSync(
      temp,
      changed.replace('"./index.ts"', '"../../src/v2/index.ts"'),
    );
    const result = await check(temp);
    if (result.code === 0 || !result.output.includes("error TS"))
      throw Error(
        `negative control did not fail: ${marker[0]}\n${result.output}`,
      );
    console.log(
      `TYPE REJECTED: ${marker[0].replace("// @ts-expect-error ", "")}`,
    );
  }
  console.log(
    `${markers.length}/${markers.length} compiler negative controls detected; ordinary strict options also pass baseline`,
  );
} finally {
  rmSync(temp, { force: true });
}
