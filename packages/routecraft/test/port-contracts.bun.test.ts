import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const repoRoot = new URL("../../../", import.meta.url).pathname;
const SNAPSHOT = join(
  repoRoot,
  "packages/routecraft/test/port-contracts.snapshot.json",
);

/** The entries whose exported ports are under the versioning promise. */
const ENTRIES = [
  "packages/routecraft/src/index.ts",
  "packages/ai/src/index.ts",
  "packages/os/src/index.ts",
];

/** The two ports 0.8 ships outside the promise; see `.standards/api-stability.md`. */
const PROVISIONAL = ["routecraft.enforcement@1", "routecraft.resilience@1"];

interface PortContract {
  /** The name the entry exports the token under. */
  export: string;
  /** Outside the versioning promise: its shape may change without a bump. */
  provisional?: true;
  /** The value type as written. */
  value: string;
  /** The value type's own members, when it is declared in this repository. */
  members?: Record<string, string>;
}

const FORMAT =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseFullyQualifiedType |
  ts.TypeFormatFlags.WriteArrowStyleSignature;

function readContracts(): Record<string, PortContract> {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(repoRoot, "tsconfig.bun-test.json"),
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
  const files = ENTRIES.map((entry) => join(repoRoot, entry));
  const program = ts.createProgram(files, parsed!.options);
  const checker = program.getTypeChecker();
  const contracts: Record<string, PortContract> = {};

  for (const file of files) {
    const module = checker.getSymbolAtLocation(program.getSourceFile(file)!)!;
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      const declaration = symbol.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration)) continue;
      const call = declaration.initializer;
      if (
        !call ||
        !ts.isCallExpression(call) ||
        !ts.isIdentifier(call.expression) ||
        call.expression.text !== "port"
      ) {
        continue;
      }
      const [nameArg] = call.arguments;
      const [typeArg] = call.typeArguments ?? [];
      if (!nameArg || !ts.isStringLiteral(nameArg) || !typeArg) {
        throw new Error(
          `${exported.name}: a port is declared as port<T>("name") so its contract can be read.`,
        );
      }
      const value = checker.getTypeFromTypeNode(typeArg);
      const own = (value.aliasSymbol ?? value.getSymbol())
        ?.getDeclarations()
        ?.some(
          (d) =>
            !d.getSourceFile().fileName.includes("/node_modules/") &&
            (ts.isInterfaceDeclaration(d) ||
              ts.isTypeAliasDeclaration(d) ||
              ts.isClassDeclaration(d)),
        );
      const members: Record<string, string> = {};
      if (own && !value.aliasTypeArguments?.length) {
        for (const member of checker.getPropertiesOfType(value)) {
          const optional = member.flags & ts.SymbolFlags.Optional ? "?" : "";
          members[`${member.name}${optional}`] = checker.typeToString(
            checker.getTypeOfSymbolAtLocation(member, declaration),
            declaration,
            FORMAT,
          );
        }
      }
      const provisional = symbol
        .getJsDocTags(checker)
        .some(
          (tag) =>
            tag.name === "remarks" &&
            ts.displayPartsToString(tag.text).startsWith("Provisional"),
        );
      contracts[nameArg.text] = {
        export: exported.name,
        ...(provisional ? { provisional: true as const } : {}),
        value: typeArg.getText(),
        ...(Object.keys(members).length > 0 ? { members } : {}),
      };
    }
  }
  return Object.fromEntries(
    Object.entries(contracts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

describe("port contracts", () => {
  /**
   * @case A port's value type cannot change shape under the same version unnoticed
   * @preconditions Every port exported from the routecraft, ai and os entries, read from source with the type checker; the committed snapshot of each one's name, value type and members
   * @expectedResult The contracts read from source equal the snapshot. A difference means a port's shape changed: bump its version (`@1` to `@2`) unless the port is provisional, then regenerate with UPDATE_PORT_CONTRACTS=1
   */
  test("match the committed snapshot", () => {
    const contracts = readContracts();
    if (process.env["UPDATE_PORT_CONTRACTS"] === "1") {
      writeFileSync(SNAPSHOT, `${JSON.stringify(contracts, null, 2)}\n`);
    }
    expect(existsSync(SNAPSHOT)).toBe(true);
    expect(contracts).toEqual(JSON.parse(readFileSync(SNAPSHOT, "utf8")));
    expect(Object.keys(contracts).length).toBeGreaterThan(15);
  }, 120_000);

  /**
   * @case Exactly the two declared ports are outside the versioning promise
   * @preconditions The committed snapshot
   * @expectedResult `routecraft.resilience@1` and `routecraft.enforcement@1` are marked provisional and no other port is, so a third exception cannot be added by tagging an export
   */
  test("only the declared exceptions are provisional", () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<
      string,
      PortContract
    >;
    const provisional = Object.entries(snapshot)
      .filter(([, contract]) => contract.provisional)
      .map(([name]) => name)
      .sort();
    expect(provisional).toEqual(PROVISIONAL);
  });
});
