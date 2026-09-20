/* eslint-disable no-console -- this executable audit reports reproducible measurements. */
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const paths = execFileSync("rg", ["--files", "packages", "tests"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter((p) => /(test|spec)\.ts$/.test(p));
const internals = [];
for (const p of paths) {
  const a = ts.createSourceFile(p, readFileSync(p, "utf8"), 99, true);
  const specs = a.statements
    .filter(ts.isImportDeclaration)
    .flatMap((n) =>
      ts.isStringLiteral(n.moduleSpecifier) ? [n.moduleSpecifier.text] : [],
    )
    .filter((s) => s.includes("/src/") && !/\/src\/index(?:\.ts)?$/.test(s));
  if (specs.length) internals.push([p, specs]);
}
console.log(
  "test files",
  paths.length,
  "import internal source path excluding package root index",
  internals.length,
);
console.log(internals);
