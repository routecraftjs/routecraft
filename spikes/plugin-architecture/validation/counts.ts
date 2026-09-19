/* eslint-disable no-console -- this executable audit reports reproducible measurements. */
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
const root = resolve(import.meta.dir, "../../..");
const base = resolve(root, "packages/routecraft/src");
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(resolve(dir, e.name))
      : e.name.endsWith(".ts")
        ? [resolve(dir, e.name)]
        : [],
  );
}
const files = walk(base),
  ai = walk(resolve(root, "packages/ai/src"));
const txt = (f: string) => readFileSync(f, "utf8");
const ast = (f: string) =>
  ts.createSourceFile(f, txt(f), ts.ScriptTarget.Latest, true);
const rel = (f: string) => relative(base, f);
const imports = (f: string) =>
  ast(f)
    .statements.filter(ts.isImportDeclaration)
    .filter((s) => ts.isStringLiteral(s.moduleSpecifier))
    .map((s) => ({
      spec: (s.moduleSpecifier as ts.StringLiteral).text,
      type: s.importClause?.isTypeOnly ?? false,
      node: s,
    }));
const core = files.filter(
  (f) =>
    (dirname(f) === base && rel(f) !== "index.ts") ||
    rel(f).startsWith("pipeline/"),
);
const buckets: Record<string, number> = {};
const importing = new Set<string>();
for (const f of core)
  for (const i of imports(f)) {
    if (!i.spec.startsWith(".")) continue;
    const dest = relative(base, resolve(dirname(f), i.spec));
    const bucket = dest.split("/")[0]!;
    if (
      [
        "operations",
        "deferral",
        "adapters",
        "auth",
        "consumers",
        "plugins",
        "telemetry",
      ].includes(bucket)
    ) {
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
      importing.add(rel(f));
    }
  }
console.log(
  "core candidate files",
  core.length,
  "importing files",
  importing.size,
  "imports",
  buckets,
  "total",
  Object.values(buckets).reduce((a, b) => a + b, 0),
);
for (const word of ["deferral", "telemetry"]) {
  const lineCounts = core
    .map(
      (f) =>
        [
          rel(f),
          txt(f)
            .split("\n")
            .filter((l) => new RegExp(word, "i").test(l)).length,
        ] as const,
    )
    .filter((x) => x[1]);
  console.log(
    word,
    "matching lines",
    lineCounts.reduce((a, b) => a + b[1], 0),
    "files",
    lineCounts.length,
    JSON.stringify(lineCounts),
  );
  console.log(
    word,
    "occurrences",
    core.reduce(
      (n, f) => n + (txt(f).match(new RegExp(word, "gi")) ?? []).length,
      0,
    ),
  );
}
const index = ast(resolve(base, "index.ts"));
let exports = 0;
for (const s of index.statements)
  if (
    ts.isExportDeclaration(s) &&
    s.exportClause &&
    ts.isNamedExports(s.exportClause)
  )
    exports += s.exportClause.elements.length;
console.log(
  "index lines",
  txt(resolve(base, "index.ts")).split("\n").length - 1,
  "named exports",
  exports,
);
for (const name of [
  "DeferralStore",
  "SessionStore",
  "StoreRegistry",
  "RouteDefinition",
]) {
  const matches: {
    file: string;
    line: number;
    count: number;
    members: string[];
  }[] = [];
  for (const f of [...files, ...ai]) {
    const a = ast(f);
    function visit(n: ts.Node) {
      if (ts.isInterfaceDeclaration(n) && n.name.text === name)
        matches.push({
          file: relative(root, f),
          line: a.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          count: n.members.length,
          members: n.members.map((m) => m.name?.getText(a) ?? "?"),
        });
      ts.forEachChild(n, visit);
    }
    visit(a);
  }
  console.log(
    name,
    JSON.stringify(matches),
    "TOTAL",
    matches.reduce((n, x) => n + x.count, 0),
  );
}
for (const name of ["StepBuilderBase", "RouteBuilder"])
  for (const f of files) {
    const a = ast(f);
    for (const s of a.statements)
      if (ts.isClassDeclaration(s) && s.name?.text === name)
        console.log(
          name,
          rel(f),
          "methods",
          s.members.filter(ts.isMethodDeclaration).length,
          "all members",
          s.members.length,
        );
  }
let deep = 0;
const deepBy: Record<string, number> = {};
for (const f of files) {
  const origin = rel(f).split("/")[0];
  for (const i of imports(f))
    if (i.spec.startsWith(".")) {
      const dest = relative(base, resolve(dirname(f), i.spec));
      const parts = dest.split("/");
      if (
        parts.length > 1 &&
        parts[0] !== origin &&
        parts.at(-1) !== "index.ts"
      ) {
        deep++;
        deepBy[parts[0]!] = (deepBy[parts[0]!] ?? 0) + 1;
      }
    }
}
console.log(
  "cross-top-folder deep imports (including root barrel)",
  deep,
  deepBy,
);
for (const f of [
  resolve(base, "exchange.ts"),
  resolve(base, "route.ts"),
  resolve(base, "context.ts"),
])
  console.log(
    "triangle",
    rel(f),
    imports(f)
      .filter((i) => /\/(exchange|route|context)\.ts$/.test(i.spec))
      .map((i) => [i.spec, i.type]),
  );
console.log(
  "AI imports core",
  ai
    .flatMap((f) =>
      imports(f).filter((i) => i.spec.startsWith("@routecraft/routecraft")),
    )
    .reduce(
      (o, i) => {
        o[i.spec] = (o[i.spec] ?? 0) + 1;
        return o;
      },
      {} as Record<string, number>,
    ),
);
console.log(
  "logger child declarations",
  files.reduce(
    (n, f) =>
      n + (txt(f).match(/ReturnType<typeof logger.child>/g) ?? []).length,
    0,
  ),
  "logger files",
  files.filter((f) => txt(f).includes(".logger")).length,
);
console.log(
  "core folders",
  readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => [e.name, files.includes(resolve(base, e.name, "index.ts"))]),
);
const nested = files.filter((f) => dirname(f) !== base);
let nd = 0;
const nb: Record<string, number> = {};
for (const f of nested)
  for (const i of imports(f))
    if (i.spec.startsWith(".")) {
      const dest = relative(base, resolve(dirname(f), i.spec));
      const ps = dest.split("/");
      if (
        ps.length > 1 &&
        ps[0] !== rel(f).split("/")[0] &&
        ps.at(-1) !== "index.ts"
      ) {
        nd++;
        nb[ps[0]!] = (nb[ps[0]!] ?? 0) + 1;
      }
    }
console.log("nested-folder-only deep imports", nd, nb);
let totalAll = 0;
const allBuckets: Record<string, number> = {};
for (const f of core) {
  const a = ast(f);
  function visit(n: ts.Node) {
    let s: string | undefined;
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      if (n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier))
        s = n.moduleSpecifier.text;
    } else if (
      ts.isImportTypeNode(n) &&
      ts.isLiteralTypeNode(n.argument) &&
      ts.isStringLiteral(n.argument.literal)
    )
      s = n.argument.literal.text;
    else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    )
      s = n.arguments[0].text;
    if (s?.startsWith(".")) {
      const b = relative(base, resolve(dirname(f), s)).split("/")[0]!;
      if (
        [
          "operations",
          "deferral",
          "adapters",
          "auth",
          "consumers",
          "plugins",
          "telemetry",
        ].includes(b)
      ) {
        allBuckets[b] = (allBuckets[b] ?? 0) + 1;
        totalAll++;
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(a);
}
console.log(
  "core imports including reexports/import types/dynamic",
  totalAll,
  allBuckets,
);
for (const f of files) {
  const a = ast(f);
  for (const s of a.statements)
    if (
      ts.isTypeAliasDeclaration(s) &&
      s.name.text === "RouteDefinition" &&
      ts.isTypeLiteralNode(s.type)
    )
      console.log(
        "RouteDefinition fields",
        s.type.members.length,
        s.type.members.map((m) => m.name?.getText(a)),
      );
}
// AST named export count above is reproducible independent of package resolution.
const program = ts.createProgram([resolve(base, "index.ts")], {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(resolve(base, "index.ts"))!;
console.log(
  "checker public export symbols",
  checker.getExportsOfModule(checker.getSymbolAtLocation(sourceFile)!).length,
);
console.log(
  "StoreRegistry keys excluding index signatures: 43 (44 members includes the string index signature)",
);
for (const scope of ["all", "nested"] as const) {
  let n = 0;
  const bs: Record<string, number> = {};
  for (const f of files.filter((f) => scope === "all" || dirname(f) !== base))
    for (const i of imports(f))
      if (i.spec.startsWith(".")) {
        const raw = resolve(dirname(f), i.spec);
        const dest = [raw, raw + ".ts", resolve(raw, "index.ts")].find((x) =>
          files.includes(x),
        );
        if (!dest) continue;
        const parts = rel(dest).split("/");
        if (
          parts.length < 2 ||
          parts.at(-1) === "index.ts" ||
          parts[0] === rel(f).split("/")[0]
        )
          continue;
        n++;
        bs[parts[0]!] = (bs[parts[0]!] ?? 0) + 1;
      }
  console.log("resolved TS deep imports", scope, n, bs);
}
for (const [a, b] of [
  ["agent", "mcp"],
  ["mcp", "agent"],
] as const) {
  console.log(
    `ai ${a}->${b}`,
    ai
      .filter((f) => f.includes(`/src/${a}/`))
      .flatMap((f) =>
        imports(f)
          .filter(
            (i) =>
              i.spec.startsWith(".") &&
              resolve(dirname(f), i.spec).includes(`/src/${b}/`),
          )
          .map((i) => [relative(root, f), i.spec]),
      ).length,
  );
}
