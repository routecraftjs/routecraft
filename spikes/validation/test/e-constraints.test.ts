import { describe, expect, test } from "bun:test";
import { report, unmatchedConstraints } from "../src/e-constraints.ts";

describe("(e) a third option for unmatched ordering constraints", () => {
  /**
   * @case A genuine optional dependency is absent
   * @preconditions admission declares after routecraft.authorize; auth is not installed
   * @expectedResult ordering stays inert and the constraint is recorded, not thrown
   */
  test("an absent optional dependency is recorded, not fatal", () => {
    const unmatched = unmatchedConstraints([
      { id: "routecraft.admission", after: ["routecraft.authorize"] },
      { id: "routecraft.retry" },
    ]);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.names).toBe("routecraft.authorize");
    expect(unmatched[0]?.suggestion).toBeUndefined();
  });

  /**
   * @case A constraint id is misspelled
   * @preconditions retry is installed; a wrapper declares after routecraft.retrry
   * @expectedResult the typo is reported with the installed id as a suggestion
   */
  test("a typo is caught by nearest-neighbour rather than swallowed", () => {
    const unmatched = unmatchedConstraints([
      { id: "acme.audit", after: ["routecraft.retrry"] },
      { id: "routecraft.retry" },
    ]);
    expect(unmatched[0]?.suggestion).toBe("routecraft.retry");
    expect(report(unmatched)).toContain('Did you mean "routecraft.retry"?');
  });

  /**
   * @case A first-party wrapper is renamed under a third party
   * @preconditions acme targets routecraft.timeout, which shipped as routecraft.deadline
   * @expectedResult the silent relocation surfaces with the new id suggested
   */
  test("a rename under a third party surfaces instead of relocating silently", () => {
    const unmatched = unmatchedConstraints([
      {
        id: "acme.audit",
        after: ["routecraft.retry"],
        before: ["routecraft.timeout"],
      },
      { id: "routecraft.retry" },
      { id: "routecraft.deadline" },
    ]);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.relation).toBe("before");
    expect(unmatched[0]?.names).toBe("routecraft.timeout");
  });

  /**
   * @case The spike's own resilience plugin, checked against its own demo
   * @preconditions resilience declares retry after routecraft.error; nothing provides it
   * @expectedResult the spike's demo chain has one unmatched constraint it never reports
   */
  test("the spike's own chain has an unreported unmatched constraint", () => {
    const unmatched = unmatchedConstraints([
      { id: "routecraft.retry", after: ["routecraft.error"] },
      { id: "routecraft.timeout", after: ["routecraft.retry"] },
      { id: "routecraft.concurrency", after: ["routecraft.timeout"] },
      {
        id: "routecraft.admission",
        after: ["routecraft.authorize"],
        before: ["routecraft.retry"],
      },
      {
        id: "acme.audit",
        after: ["routecraft.retry"],
        before: ["routecraft.timeout"],
      },
    ]);
    expect(unmatched.map((u) => u.names).sort()).toEqual([
      "routecraft.authorize",
      "routecraft.error",
    ]);
  });
});
