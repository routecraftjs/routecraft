import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * The AI namespace's codes are registered in `src/errors.ts` and documented in
 * two places the compiler cannot connect: the error reference page's prose and
 * the docs site's hand-maintained error row data. Core covers its own
 * codes in `packages/routecraft/test/error-registry.bun.test.ts`; this is the
 * same guard for the `AI` namespace, which that registry cannot see because
 * core does not import this package.
 */
describe("AI error codes", () => {
  const read = (path: string): Promise<string> =>
    readFile(new URL(path, import.meta.url), "utf8");

  const registeredCodes = async (): Promise<string[]> => {
    const source = await read("../src/errors.ts");
    return Array.from(
      source.matchAll(/^\s*(AI\d{4}):\s*\{/gm),
      (match) => match[1]!,
    );
  };

  /**
   * @case Every AI code has a row in the docs error table
   * @preconditions Codes registered in src/errors.ts; _data/errors.json read from disk
   * @expectedResult Each AI code appears in the table, so a code added without its row fails here rather than going missing from the published table
   */
  test("every AI code appears in the docs error table", async () => {
    // The rows live under src/app/docs so the release freeze pins them to the
    // version they describe; ErrorTable.tsx renders whatever this file declares.
    const rows = JSON.parse(
      await read("../../../apps/routecraft.dev/src/app/docs/_data/errors.json"),
    ) as Array<{ code: string }>;
    const listed = new Set(rows.map((row) => row.code));

    const codes = await registeredCodes();
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.filter((code) => !listed.has(code))).toEqual([]);
  });

  /**
   * @case Every AI code has a section on the error reference page
   * @preconditions Codes registered in src/errors.ts; errors/page.md read from disk
   * @expectedResult Each AI code has its own heading, so the docs link on the error meta resolves to a real section
   */
  test("every AI code has an error reference section", async () => {
    const page = await read(
      "../../../apps/routecraft.dev/src/app/docs/reference/errors/page.md",
    );
    const documented = new Set(
      Array.from(page.matchAll(/^## (AI\d{4})$/gm), (match) => match[1]),
    );

    const codes = await registeredCodes();
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.filter((code) => !documented.has(code))).toEqual([]);
  });
});
