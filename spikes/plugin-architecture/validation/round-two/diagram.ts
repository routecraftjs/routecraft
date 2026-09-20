/* eslint-disable no-console -- Executable spike reports intentionally write validation evidence. */
/**
 * Checks the module diagram against the modules.
 *
 * A diagram nobody executes is a comment that rots, and this one claims to show
 * an enforced boundary. It is derived here from the same AST walk the import
 * gate uses, so a drawn edge that does not exist and an import that is not drawn
 * both fail.
 */
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
const src = resolve(import.meta.dir, "../../src/v2"),
  doc = resolve(import.meta.dir, "../../DIAGRAMS.md");

const block = /```mermaid\n(graph TD[\s\S]*?)```/.exec(
  readFileSync(doc, "utf8"),
);
if (!block) throw Error("DIAGRAMS.md: the module graph block is missing");
const mermaid = block[1];

const label = new Map<string, string>();
for (const [, id, text] of mermaid.matchAll(/^\s*(\w+)\["([^"]+)"\]/gm)) {
  const file = /([\w.-]+\.ts)/.exec(text);
  if (file) label.set(id, file[1]);
}
const drawn = new Set<string>();
for (const [, from, to] of mermaid.matchAll(/^\s*(\w+)\s*-->\s*(\w+)\s*$/gm)) {
  const a = label.get(from),
    b = label.get(to);
  if (!a || !b)
    throw Error(`DIAGRAMS.md: edge ${from} --> ${to} names an unlabelled node`);
  drawn.add(`${a} -> ${b}`);
}

const actual = new Set<string>();
for (const name of readdirSync(src).filter((f) => f.endsWith(".ts"))) {
  const file = ts.createSourceFile(
    name,
    readFileSync(resolve(src, name), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const record = (spec: string) => {
    if (spec.startsWith("."))
      actual.add(`${name} -> ${basename(resolve(src, spec))}`);
  };
  const walk = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      record(node.moduleSpecifier.text);
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      record(node.arguments[0].text);
    ts.forEachChild(node, walk);
  };
  walk(file);
}

// demo.ts and types.check.ts are executable examples rather than architecture,
// so the diagram omits them by design; their edges are still gated.
const omitted = new Set(["demo.ts", "types.check.ts"]);
const real = [...actual].filter((e) => !omitted.has(e.split(" -> ")[0]));
const missing = real.filter((e) => !drawn.has(e));
const invented = [...drawn].filter((e) => !actual.has(e));
for (const e of missing) console.error(`UNDRAWN import: ${e}`);
for (const e of invented) console.error(`DRAWN but absent: ${e}`);
if (missing.length || invented.length)
  throw Error(
    `DIAGRAMS.md module graph disagrees with src/v2 (${missing.length} undrawn, ${invented.length} invented)`,
  );
console.log(
  `DIAGRAM: module graph matches src/v2 (${drawn.size} edges, ${omitted.size} example modules omitted by design)`,
);
