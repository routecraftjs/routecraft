/* eslint-disable no-console -- Compiler evidence. */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "bun";
const root = resolve(import.meta.dir, "../..");
const file = resolve(import.meta.dir, "language.check.ts");
const tmp = resolve(import.meta.dir, "language.generated.ts");
const source = readFileSync(file, "utf8");
async function check(path: string) {
  const p = spawn(
    [
      process.execPath,
      resolve(root, "../../node_modules/typescript/bin/tsc"),
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
      path,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code, output: out + err };
}
try {
  const baseline = await check(file);
  if (baseline.code) throw Error(baseline.output);
  console.log(
    "TYPE PASS: unchecked option strings, composite facet, broad Handler exit refusal, project-bound route callback",
  );
  for (const marker of source.matchAll(/\/\/ @ts-expect-error[^\n]*/g)) {
    writeFileSync(
      tmp,
      source.slice(0, marker.index) +
        source.slice(marker.index! + marker[0].length),
    );
    const r = await check(tmp);
    if (!r.code || !r.output.includes("error TS"))
      throw Error("control did not reject " + marker[0]);
    console.log(
      "TYPE REJECTED: " + marker[0].replace("// @ts-expect-error ", ""),
    );
  }
} finally {
  rmSync(tmp, { force: true });
}
