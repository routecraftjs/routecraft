/* eslint-disable no-console -- this executable audit reports reproducible measurements. */
import ts from "typescript";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dir, "../../..");
function walk(p: string): string[] {
  return readdirSync(p, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(resolve(p, e.name))
      : e.name.endsWith(".ts")
        ? [resolve(p, e.name)]
        : [],
  );
}
const core = resolve(root, "packages/routecraft/src"),
  files = walk(resolve(root, "packages")).filter(
    (f) => f.includes("/src/") && !f.includes("/node_modules/"),
  );
const read = (f: string) => readFileSync(f, "utf8");
console.log(
  "all packages logger child references",
  files.reduce(
    (n, f) =>
      n + (read(f).match(/ReturnType<typeof logger.child>/g) ?? []).length,
    0,
  ),
  "logger files",
  files.filter((f) => read(f).includes(".logger")).length,
);
const counts: Record<string, { imports: number; consumers: Set<string> }> = {};
for (const f of walk(core)) {
  const a = ts.createSourceFile(f, read(f), 99, true);
  for (const s of a.statements)
    if (
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text.startsWith(".")
    ) {
      const dest = resolve(dirname(f), s.moduleSpecifier.text);
      if (dest.startsWith(core + "/shared/")) {
        const key = relative(core + "/shared", dest);
        const v = (counts[key] ??= { imports: 0, consumers: new Set() });
        v.imports++;
        v.consumers.add(relative(core, f).split("/")[0]!);
      }
    }
}
console.log(
  "shared",
  Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [
      k,
      {
        imports: v.imports,
        consumers: [...v.consumers],
        count: v.consumers.size,
      },
    ]),
  ),
);
for (const f of files) {
  const a = ts.createSourceFile(f, read(f), 99, true);
  for (const n of a.statements)
    if (
      ts.isClassDeclaration(n) &&
      n.name &&
      [
        "StepBuilderBase",
        "RouteBuilder",
        "MailClientManager",
        "CarddavClientManager",
      ].includes(n.name.text)
    ) {
      const methods = n.members.filter(ts.isMethodDeclaration);
      console.log(
        "class",
        n.name.text,
        "fileLines",
        read(f).split("\n").length - 1,
        "classLines",
        a.getLineAndCharacterOfPosition(n.end).line -
          a.getLineAndCharacterOfPosition(n.getStart()).line +
          1,
        "declarations",
        methods.length,
        "implementations",
        methods.filter((m) => !!m.body).length,
        "names",
        methods.map((m) => m.name.getText(a)),
      );
    }
}
const testDir = resolve(root, "packages/routecraft/test");
const tests = existsSync(testDir)
  ? walk(testDir).filter((f) => /test\.ts$/.test(f))
  : [];
console.log(
  "core test files",
  tests.length,
  "internal import files",
  tests.filter((f) => /from\s+["'][^"']*(?:\/src\/|@internal)/.test(read(f)))
    .length,
);
console.log(
  "SDK files",
  files
    .filter((f) => /import(?:\s.*from\s*|\()["']ai["']/.test(read(f)))
    .map((f) => relative(root, f)),
);
console.log(
  "continuation headers",
  read(resolve(core, "exchange.ts"))
    .split("\n")
    .filter((l) => /routecraft\.deferral\./.test(l)),
);
const log = execFileSync(
  "git",
  [
    "log",
    "--since=2025-09-19",
    "--until=2026-09-20",
    "--format=COMMIT %H",
    "--no-renames",
    "--numstat",
    "--",
    "packages/*/src/**/*.ts",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 80 * 1024 * 1024 },
);
const groups: Record<
  string,
  { lines: number; files: Set<string>; edits: number }
> = {};
const perFile: Record<string, { lines: number; edits: number }> = {};
for (const l of log.split("\n")) {
  const m = /^(\d+)\t(\d+)\t(packages\/[^/]+\/src\/[^/]+\/.*\.ts)$/.exec(l);
  if (!m) continue;
  const f = m[3]!,
    g = f
      .split("/")
      .slice(1, 4)
      .filter((x) => x !== "src")
      .join("/");
  const v = (groups[g] ??= { lines: 0, files: new Set(), edits: 0 });
  v.lines += Number(m[1]) + Number(m[2]);
  v.files.add(f);
  v.edits++;
  const p = (perFile[f] ??= { lines: 0, edits: 0 });
  p.lines += Number(m[1]) + Number(m[2]);
  p.edits++;
}
console.log(
  "churn (fixed window, --no-renames; each changed path counted once per commit)",
  Object.fromEntries(
    Object.entries(groups).map(([k, v]) => [
      k,
      {
        lines: v.lines,
        files: v.files.size,
        editsPerFile: (v.edits / v.files.size).toFixed(1),
      },
    ]),
  ),
);
console.log(
  "executor churn",
  perFile["packages/routecraft/src/pipeline/executor.ts"],
);
console.log(
  "dispatcher churn",
  perFile["packages/routecraft/src/plugins/http/dispatcher.ts"],
);
console.log(
  "20 most edited",
  Object.entries(perFile)
    .sort((a, b) => b[1].edits - a[1].edits)
    .slice(0, 20),
);
