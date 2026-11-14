import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const repoRoot = new URL("../../../", import.meta.url).pathname;
const outsiderDir = join(repoRoot, "packages/routecraft/test/outsider");
const suites = readdirSync(outsiderDir, { recursive: true })
  .map(String)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join(outsiderDir, name));

/** Everything an outsider suite may import from. */
const ALLOWED_SPECIFIERS = new Set([
  "bun:test",
  "@routecraft/routecraft",
  "@routecraft/testing",
  "@routecraft/ai",
  "@routecraft/os",
]);

/**
 * Every module a file reaches, by any syntax: a static import, a re-export,
 * `import()`, `require()` and `import x = require()`. A specifier that is
 * not a string literal is reported as such, since it cannot be checked.
 */
function specifiersOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const literal = (node: ts.Node | undefined): string =>
    node && ts.isStringLiteralLike(node) ? node.text : "<computed>";
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      found.push(literal(node.moduleSpecifier));
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      found.push(literal(node.arguments[0]));
    } else if (ts.isExternalModuleReference(node)) {
      found.push(literal(node.expression));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("outsider harness guard", () => {
  /**
   * @case The outsider suites import by package name only
   * @preconditions Every file under `test/outsider/`
   * @expectedResult Each static import, re-export, `import()` and `require()` names `bun:test` or a published `@routecraft/*` package: no relative path, no `/src/`, no `/internal`, no other package
   */
  test("imports only published package names", () => {
    expect(suites.length).toBeGreaterThan(0);
    const strays: string[] = [];
    for (const file of suites) {
      for (const specifier of specifiersOf(file)) {
        if (!ALLOWED_SPECIFIERS.has(specifier)) {
          strays.push(`${file.slice(repoRoot.length)}: ${specifier}`);
        }
      }
    }
    expect(strays).toEqual([]);
  });

  /**
   * @case An outsider suite cannot reach a kernel symbol by its registered name
   * @preconditions Every file under `test/outsider/`
   * @expectedResult No file mentions `Symbol.for("routecraft.`, the one way to reach a mark without importing it
   */
  test("forges no registered symbol", () => {
    const strays = suites.filter((file) =>
      /Symbol\.for\(\s*["'`]routecraft\./.test(readFileSync(file, "utf8")),
    );
    expect(strays).toEqual([]);
  });

  /**
   * @case Every name an outsider suite imports is public
   * @preconditions The suites type-checked as one program against the workspace sources
   * @expectedResult Every import is a named one, and no imported name resolves to a declaration tagged `@internal`; a namespace or default import is refused because its members cannot be checked by name
   */
  test("imports no @internal name", () => {
    const configPath = join(repoRoot, "tsconfig.bun-test.json");
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          );
        },
      },
    );
    const program = ts.createProgram(suites, parsed!.options);
    const checker = program.getTypeChecker();
    const strays: string[] = [];
    for (const file of suites) {
      const source = program.getSourceFile(file)!;
      for (const declaration of source.statements.filter(
        ts.isImportDeclaration,
      )) {
        const clause = declaration.importClause;
        const bindings = clause?.namedBindings;
        if (
          !clause ||
          clause.name ||
          !bindings ||
          !ts.isNamedImports(bindings)
        ) {
          strays.push(
            `${file.slice(repoRoot.length)}: ${declaration.getText(source)} is not a named import`,
          );
          continue;
        }
        for (const element of bindings.elements) {
          const local = checker.getSymbolAtLocation(element.name);
          if (!local) continue;
          const target =
            local.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(local)
              : local;
          const internal = target
            .getJsDocTags(checker)
            .some((tag) => tag.name === "internal");
          if (internal) {
            strays.push(`${file.slice(repoRoot.length)}: ${element.name.text}`);
          }
        }
      }
    }
    expect(strays).toEqual([]);
  }, 120_000);
});
