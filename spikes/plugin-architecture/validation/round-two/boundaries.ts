/* eslint-disable no-console -- Executable spike reports intentionally write validation evidence. */
/**
 * Resolved AST import gate; production core cannot reach operations/storage or
 * legacy spike modules.
 *
 * The allowlist is closed over the directory rather than an enumeration a new
 * file can sit outside of, and the walk covers every node rather than the
 * top-level statements, because a dynamic `import()` in a function body is the
 * cheapest way around a boundary that only reads the file's header.
 */
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../../src/v2");
const allowed: Record<string, readonly string[]> = {
  "contracts.ts": [],
  "graph.ts": ["contracts.ts"],
  "host.ts": ["contracts.ts", "graph.ts"],
  "codec.ts": ["contracts.ts"],
  "runtime.ts": ["contracts.ts", "host.ts", "codec.ts"],
  "dsl.ts": ["contracts.ts", "host.ts", "runtime.ts"],
  "operations.ts": ["contracts.ts", "dsl.ts"],
  "storage.ts": ["contracts.ts", "dsl.ts", "codec.ts"],
  "auth.ts": ["contracts.ts", "dsl.ts"],
  "index.ts": [
    "contracts.ts",
    "dsl.ts",
    "host.ts",
    "runtime.ts",
    "operations.ts",
    "storage.ts",
    "auth.ts",
    "codec.ts",
  ],
  "demo.ts": ["index.ts"],
  "types.check.ts": ["index.ts"],
};
const present = readdirSync(root).filter((f) => f.endsWith(".ts"));
for (const name of present)
  if (!(name in allowed))
    throw Error(
      `${name}: module is not declared in the import gate; add it with its allowed targets`,
    );
for (const name of Object.keys(allowed))
  if (!present.includes(name))
    throw Error(`${name}: declared in the import gate but absent on disk`);
let count = 0,
  dynamic = 0;
for (const [name, targets] of Object.entries(allowed)) {
  const file = ts.createSourceFile(
    name,
    readFileSync(resolve(root, name), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const check = (spec: string, kind: "static" | "dynamic") => {
    if (spec.startsWith(".")) {
      const target = resolve(root, spec);
      if (!targets.some((t) => resolve(root, t) === target))
        throw Error(`${name}: forbidden ${kind} import ${spec}`);
      count++;
      if (kind === "dynamic") dynamic++;
      return;
    }
    if (spec.startsWith("node:")) return;
    if (name === "storage.ts" && spec === "bun:sqlite") return;
    throw Error(`${name}: undeclared external ${kind} import ${spec}`);
  };
  const walk = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      check(node.moduleSpecifier.text, "static");
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const [first] = node.arguments;
      if (!first || !ts.isStringLiteral(first))
        throw Error(`${name}: non-literal dynamic import defeats the gate`);
      check(first.text, "dynamic");
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      check(node.argument.literal.text, "static");
    ts.forEachChild(node, walk);
  };
  walk(file);
}
console.log(
  `BOUNDARIES: ${present.length} modules (all declared), ${count} permitted import edges (${dynamic} dynamic), no private/legacy imports`,
);
