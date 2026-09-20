/* eslint-disable no-console -- Executable spike reports intentionally write validation evidence. */
/** Resolved AST import gate; production core cannot reach operations/storage or legacy spike modules. */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../../src/v2");
const allowed: Record<string, readonly string[]> = {
  "contracts.ts": [],
  "graph.ts": ["contracts.ts"],
  "host.ts": ["contracts.ts", "graph.ts"],
  "runtime.ts": ["contracts.ts", "host.ts"],
  "dsl.ts": ["contracts.ts", "host.ts", "runtime.ts"],
  "operations.ts": ["contracts.ts", "dsl.ts"],
  "storage.ts": ["contracts.ts", "dsl.ts"],
};
let count = 0;
for (const [name, targets] of Object.entries(allowed)) {
  const file = ts.createSourceFile(
    name,
    readFileSync(resolve(root, name), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
    )
      continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const spec = specifier.text;
    if (spec.startsWith(".")) {
      const target = resolve(root, spec);
      if (!targets.some((t) => resolve(root, t) === target))
        throw Error(`${name}: forbidden import ${spec}`);
      count++;
    } else if (
      !spec.startsWith("node:") &&
      !(name === "storage.ts" && spec === "bun:sqlite")
    )
      throw Error(`${name}: undeclared external import ${spec}`);
  }
}
console.log(
  `BOUNDARIES: ${Object.keys(allowed).length} modules, ${count} permitted import edges, no private/legacy imports`,
);
