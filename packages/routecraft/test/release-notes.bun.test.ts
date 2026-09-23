/**
 * The GitHub Release body the release job writes for each published package.
 *
 * Lives beside `core-version-range-contract.bun.test.ts` for the same reason:
 * it guards a repository script under `scripts/lib`, which no package owns,
 * and the release depends on it. 0.7.0's core notes exceeded GitHub's limit,
 * the release was rejected, and the rest of the release job was skipped.
 */

import { describe, expect, test } from "bun:test";

import {
  changelogSection,
  RELEASE_BODY_LIMIT,
  releaseNotes,
} from "../../../scripts/lib/release-notes.mjs";

const LINK = "https://example.test/CHANGELOG.md";

const FOOTER =
  "\n\n---\n\nThese notes are cut to fit a GitHub Release. " +
  `The full notes are in the [changelog](${LINK}).`;

/** A changesets section of `count` entries, each `size` characters long. */
function section(count: number, size: number): string {
  const entries = Array.from(
    { length: count },
    (_, i) => `- entry ${i} ${"x".repeat(size)}`,
  );
  return ["### Minor Changes", "", ...entries].join("\n");
}

describe("changelogSection", () => {
  /**
   * @case A version's section sits between two others
   * @preconditions A changelog with 0.7.0 above 0.6.0
   * @expectedResult Only the 0.7.0 body comes back, without its heading and without 0.6.0
   */
  test("reads one version and stops at the next", () => {
    const changelog = [
      "# pkg",
      "",
      "## 0.7.0",
      "",
      "- new",
      "",
      "## 0.6.0",
      "",
      "- old",
    ].join("\n");
    expect(changelogSection(changelog, "0.7.0")).toBe("- new");
  });

  /**
   * @case The version has no section
   * @preconditions A changelog without a 0.8.0 heading
   * @expectedResult An empty string, which becomes an empty release body
   */
  test("is empty for a version the changelog does not carry", () => {
    expect(changelogSection("# pkg\n\n## 0.7.0\n\n- a", "0.8.0")).toBe("");
  });
});

describe("releaseNotes", () => {
  /**
   * @case A section that fits GitHub's limit
   * @preconditions A section well under the limit
   * @expectedResult The section is returned unchanged, with no footer
   */
  test("leaves a section that fits alone", () => {
    const body = section(3, 100);
    expect(releaseNotes(body, LINK)).toBe(body);
  });

  /**
   * @case A section over the limit, as core's 0.7.0 notes were
   * @preconditions A section of entries whose total exceeds the limit
   * @expectedResult The body fits the limit, ends in a link to the full changelog, and every entry it keeps is whole
   */
  test("cuts an oversized section on an entry and links the rest", () => {
    const body = section(400, 500);
    expect(body.length).toBeGreaterThan(RELEASE_BODY_LIMIT);

    const notes = releaseNotes(body, LINK);

    expect(notes.length).toBeLessThanOrEqual(RELEASE_BODY_LIMIT);
    expect(notes.endsWith(`[changelog](${LINK}).`)).toBe(true);
    const kept = notes.split("\n\n---\n\n")[0] ?? "";
    for (const line of kept.split("\n").filter((l) => l.startsWith("- "))) {
      expect(line).toMatch(/^- entry \d+ x{500}$/);
    }
  });

  /**
   * @case A section exactly at the limit, and one character over it
   * @preconditions Sections of `limit` and `limit + 1` characters
   * @expectedResult The first is returned unchanged; the second is cut, fits the limit, and links the full changelog
   */
  test("treats the limit as inclusive", () => {
    const limit = 500;
    const exact = section(4, 200).slice(0, limit);
    expect(exact.length).toBe(limit);
    expect(releaseNotes(exact, LINK, limit)).toBe(exact);

    const over = section(4, 200).slice(0, limit + 1);
    const notes = releaseNotes(over, LINK, limit);
    expect(notes.length).toBeLessThanOrEqual(limit);
    expect(notes.endsWith(`[changelog](${LINK}).`)).toBe(true);
  });

  /**
   * @case The budget ends exactly where an entry ends
   * @preconditions Three entries, and a limit whose budget stops at the end of the second
   * @expectedResult The second entry is kept whole and the third is cut
   */
  test("keeps an entry that ends exactly on the budget", () => {
    const body = `- AAA\n- BBB\n- CCC ${"c".repeat(500)}`;
    const limit = "- AAA\n- BBB".length + FOOTER.length;

    const notes = releaseNotes(body, LINK, limit);

    expect(notes).toBe(`- AAA\n- BBB${FOOTER}`);
  });

  /**
   * @case The budget lands in the first entry of a later group
   * @preconditions Two `### ` groups, and a limit whose budget stops inside the second group's first entry
   * @expectedResult The first group is kept whole and the second group's heading is dropped rather than left bare
   */
  test("drops a group heading left with no entries", () => {
    const first = "### Minor Changes\n\n- a1\n- a2";
    const body = `${first}\n\n### Patch Changes\n\n- b1 ${"z".repeat(500)}`;
    const limit =
      `${first}\n\n### Patch Changes\n\n- b1`.length + FOOTER.length;

    const notes = releaseNotes(body, LINK, limit);

    expect(notes).toBe(`${first}${FOOTER}`);
  });

  /**
   * @case The budget lands inside a group heading
   * @preconditions Two `### ` groups, and a limit whose budget stops inside the second heading
   * @expectedResult The body is cut before that heading, keeping the first group whole
   */
  test("cuts before a group heading the budget splits", () => {
    const first = "### Minor Changes\n\n- a1\n- a2";
    const body = `${first}\n\n### Patch Changes\n\n- b1 ${"z".repeat(500)}`;
    const limit = `${first}\n\n### Pat`.length + FOOTER.length;

    const notes = releaseNotes(body, LINK, limit);

    expect(notes).toBe(`${first}${FOOTER}`);
  });

  /**
   * @case A limit smaller than the footer itself
   * @preconditions A long section and a limit shorter than the truncation footer
   * @expectedResult The body still never exceeds the limit
   */
  test("never exceeds a limit shorter than its own footer", () => {
    const notes = releaseNotes(section(10, 100), LINK, 50);
    expect(notes.length).toBeLessThanOrEqual(50);
  });

  /**
   * @case A section with no entry boundary inside the budget
   * @preconditions A single entry, with no line break, longer than the whole limit
   * @expectedResult The body still fits the limit and still links the full changelog
   */
  test("fits even when no entry boundary is available", () => {
    const notes = releaseNotes(`- ${"y".repeat(1000)}`, LINK, 300);
    expect(notes.length).toBeLessThanOrEqual(300);
    expect(notes.endsWith(`[changelog](${LINK}).`)).toBe(true);
  });
});
