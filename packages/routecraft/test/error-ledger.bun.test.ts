import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { RC } from "../src/index.ts";

const repoRoot = new URL("../../../", import.meta.url).pathname;

interface LedgerRow {
  code: string;
  status: "reserved" | "retired";
}

function readLedger(): LedgerRow[] {
  const standard = readFileSync(
    `${repoRoot}.standards/error-and-logging-policy.md`,
    "utf8",
  );
  const section = standard.split("### The `RC` code ledger")[1] ?? "";
  const rows: LedgerRow[] = [];
  for (const line of section.split("\n### ")[0]!.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    const [, code, status] = cells;
    if (cells.length < 4 || code === "Code" || /^-+$/.test(code ?? ""))
      continue;
    if (
      !/^RC\d{4}$/.test(code!) ||
      !["reserved", "retired"].includes(status!)
    ) {
      throw new Error(`The RC code ledger holds a malformed row: ${line}`);
    }
    rows.push({ code: code!, status: status as LedgerRow["status"] });
  }
  return rows;
}

/** A series is the codes that share their first two digits: `RC10xx`, `RC11xx`. */
function seriesOf(code: string): string {
  return code.slice(0, 4);
}

describe("RC code ledger", () => {
  const registered = Object.keys(RC);
  const ledger = readLedger();

  /**
   * @case The ledger in the standard is readable and well-formed
   * @preconditions `.standards/error-and-logging-policy.md` carries the ledger table
   * @expectedResult At least one row; every row is reserved or retired; no code is listed twice; rows are in ascending order
   */
  test("the ledger parses, has no duplicates and is sorted", () => {
    expect(ledger.length).toBeGreaterThan(0);
    for (const row of ledger) {
      expect(["reserved", "retired"]).toContain(row.status);
    }
    const codes = ledger.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([...codes].sort());
  });

  /**
   * @case A code cannot be both in use and on the ledger
   * @preconditions The registered core codes and the ledger rows
   * @expectedResult No overlap: a reserved row leaves the ledger when its code lands, and a retired code never returns
   */
  test("no registered code is reserved or retired", () => {
    const listed = new Set(ledger.map((row) => row.code));
    expect(registered.filter((code) => listed.has(code))).toEqual([]);
  });

  /**
   * @case Every number in a series is accounted for
   * @preconditions The registered core codes and the ledger rows, grouped into series
   * @expectedResult From the first code of each series to its highest, every number is registered, reserved or retired
   */
  test("no series has an unexplained gap", () => {
    const known = new Set([...registered, ...ledger.map((row) => row.code)]);
    const highest = new Map<string, number>();
    for (const code of known) {
      const series = seriesOf(code);
      const n = Number(code.slice(2));
      highest.set(series, Math.max(highest.get(series) ?? 0, n));
    }
    const gaps: string[] = [];
    for (const [series, max] of highest) {
      const first = Number(series.slice(2)) * 100 + 1;
      for (let n = first; n <= max; n++) {
        if (!known.has(`RC${n}`)) gaps.push(`RC${n}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  /**
   * @case Source names only codes that exist or once existed
   * @preconditions Every `.ts` and `.tsx` file under `packages/*\/src`
   * @expectedResult Each `RCnnnn` literal is a registered code, or a retired one named in a comment, so a reserved code cannot be used before it is registered, a retired one cannot be raised again and a typo cannot ship
   */
  test("no source file names an unregistered code", async () => {
    const known = new Set(registered);
    const retired = new Set(
      ledger.filter((row) => row.status === "retired").map((r) => r.code),
    );
    const strays: string[] = [];
    for await (const file of new Glob("packages/*/src/**/*.{ts,tsx}").scan({
      cwd: repoRoot,
    })) {
      const source = readFileSync(`${repoRoot}${file}`, "utf8");
      for (const line of source.split("\n")) {
        const comment = /^\s*(\*|\/\/|\/\*)/.test(line);
        for (const [code] of line.matchAll(/\bRC\d{4}\b/g)) {
          if (known.has(code) || (comment && retired.has(code))) continue;
          strays.push(`${file}: ${code}`);
        }
      }
    }
    expect(strays).toEqual([]);
  });
});
