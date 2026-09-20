/* eslint-disable no-console -- this executable audit reports reproducible measurements. */
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
const root = resolve(import.meta.dir, "../../..");
const walk = (p: string): string[] =>
  readdirSync(p, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(resolve(p, e.name))
      : e.name.endsWith(".ts")
        ? [resolve(p, e.name)]
        : [],
  );
for (const pkg of ["routecraft", "ai"]) {
  const base = resolve(root, "packages", pkg, "src"),
    files = walk(base),
    edges = new Map<string, string[]>();
  for (const f of files) {
    const output = ts.transpileModule(readFileSync(f, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        verbatimModuleSyntax: true,
      },
    }).outputText;
    const a = ts.createSourceFile(f, output, 99, true);
    const deps: string[] = [];
    for (const s of a.statements)
      if (
        (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) &&
        s.moduleSpecifier &&
        ts.isStringLiteral(s.moduleSpecifier)
      ) {
        const spec = s.moduleSpecifier.text;
        if (!spec.startsWith(".")) continue;
        const p = resolve(dirname(f), spec);
        const dest = [p, p + ".ts", resolve(p, "index.ts")].find((x) =>
          files.includes(x),
        );
        if (dest) deps.push(dest);
      }
    edges.set(f, deps);
  }
  let next = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    active = new Set<string>(),
    scc: string[][] = [];
  function visit(f: string) {
    indices.set(f, next);
    low.set(f, next++);
    stack.push(f);
    active.add(f);
    for (const d of edges.get(f) ?? []) {
      if (!indices.has(d)) {
        visit(d);
        low.set(f, Math.min(low.get(f)!, low.get(d)!));
      } else if (active.has(d))
        low.set(f, Math.min(low.get(f)!, indices.get(d)!));
    }
    if (low.get(f) === indices.get(f)) {
      const group: string[] = [];
      let d: string;
      do {
        d = stack.pop()!;
        active.delete(d);
        group.push(relative(base, d));
      } while (d !== f);
      if (group.length > 1) scc.push(group);
    }
  }
  for (const f of files) if (!indices.has(f)) visit(f);
  console.log(pkg, "static emitted-JS SCCs", JSON.stringify(scc));
  if (pkg === "ai")
    console.log("events outbound", edges.get(resolve(base, "agent/events.ts")));
}
