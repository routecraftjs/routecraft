/* eslint-disable no-console -- Executable review evidence. */
/**
 * Type-level scale of the round-five DSL encoding in `src/v2/dsl.ts`.
 *
 * The historical fixture (`src/typed/e-scale.check.ts`) measured 40 families
 * against the round-three encoding, which the round-five code does not use.
 * Nothing measures `application([...20 plugins])` with a long chain against
 * the code that would ship. This generates that fixture at three sizes,
 * compiles each with `tsc --extendedDiagnostics`, and prints check time,
 * type instantiations and memory. One method, one commit, stated on output.
 */
import { spawn } from "bun";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
const compiler = resolve(root, "../../node_modules/typescript/bin/tsc");
const out = resolve(import.meta.dir, "generated");
mkdirSync(out, { recursive: true });

function fixture(plugins: number, steps: number, facets: boolean): string {
  const lines: string[] = [
    `import { application, operations, resilience, deferral, sqlite, manual, type Plugin, type Family, type Cursor, type Chain, type Phase, type Source } from "../../../src/v2/index.ts";`,
  ];
  for (let i = 0; i < plugins; i++) {
    lines.push(
      `type M${i}<B, P extends readonly Plugin[], H extends object> = { op${i}(this: Cursor<B, P, H, "after">): Chain<B, P, H, "after">; op${i}n(this: Cursor<B, P, H, "after">): Chain<number, P, H, "after"> };`,
      `interface F${i} extends Family { readonly methods: M${i}<this["Body"], this["Plugins"], this["Headers"]>; }`,
      facets
        ? `const facets${i} = { f${i}: () => ({ n: ${i} }) };`
        : `const facets${i} = {};`,
      `export const p${i}: Plugin<F${i}, typeof facets${i}> = { id: "p${i}", facets: facets${i}, methods: <B, P extends readonly Plugin[], H extends object, S extends Phase>(c: Cursor<B, P, H, S>): M${i}<B, P, H> => ({ op${i}: () => c.map((b) => b), op${i}n: () => c.map(() => ${i}) }) };`,
    );
  }
  const list = Array.from({ length: plugins }, (_, i) => `p${i}`).join(", ");
  lines.push(
    `const app = application([operations, resilience, deferral, sqlite(":memory:"), ${list}]);`,
    `const source: Source<{ subject: string }> = manual;`,
    `export const route = app.route<{ trace: string }>("scale").retry(2).from(source)`,
  );
  for (let s = 0; s < steps; s++) {
    const i = s % plugins;
    lines.push(
      s % 3 === 2
        ? `  .transform((b, ex) => { void ex.headers.trace; ${facets ? `void ex.f${i}.n;` : ""} return String(b); })`
        : s % 3 === 1
          ? `  .op${i}n()`
          : `  .op${i}()`,
    );
  }
  lines.push(`  .defer("approval").build();`);
  return lines.join("\n") + "\n";
}

async function measure(name: string, source: string) {
  const file = resolve(out, `${name}.ts`);
  writeFileSync(file, source);
  const p = spawn(
    [
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
      "--extendedDiagnostics",
      file,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const code = await p.exited;
  const text =
    (await new Response(p.stdout).text()) +
    (await new Response(p.stderr).text());
  const pick = (label: string) =>
    text.match(new RegExp(`${label}:\\s+([\\d.,]+\\w*)`))?.[1] ?? "?";
  const errors = [...text.matchAll(/error TS\d+/g)].length;
  console.log(
    `${name.padEnd(28)} exit ${code}  errors ${errors}  check ${pick("Check time")}  total ${pick("Total time")}  instantiations ${pick("Instantiations")}  types ${pick("Types")}  memory ${pick("Memory used")}`,
  );
  if (errors)
    console.log(
      text
        .split("\n")
        .filter((l) => l.includes("error TS"))
        .slice(0, 5)
        .join("\n"),
    );
}

console.log(
  `tsc ${(await new Response(spawn([process.execPath, compiler, "--version"], { stdout: "pipe" }).stdout).text()).trim()}`,
);
await measure("plugins05-steps12", fixture(5, 12, true));
await measure("plugins20-steps40", fixture(20, 40, true));
await measure("plugins20-steps40-nofacet", fixture(20, 40, false));
await measure("plugins40-steps80", fixture(40, 80, true));
rmSync(out, { recursive: true, force: true });
