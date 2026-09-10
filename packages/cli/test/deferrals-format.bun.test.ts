import { describe, expect, test } from "bun:test";
import type { OpsDeferralSummary, OpsPage } from "@routecraft/routecraft";
import { renderDeferral, renderDeferrals } from "../src/format";

/**
 * How `craft ops deferrals` reads at a terminal.
 *
 * The listing answers one question, which is what is still owed an
 * answer, so the rendering is judged on whether that is readable at a
 * glance: what waits, on what, since when, and whether anything already
 * holds it. The page is bounded, so it also has to say when there is more
 * rather than letting a reader take the first screen for the whole set.
 */

function waiting(
  overrides: Partial<OpsDeferralSummary> = {},
): OpsDeferralSummary {
  return {
    id: "ex-1#0",
    routeId: "payout",
    state: "waiting",
    waitingFor: "resume",
    claimed: false,
    deferredAt: "2026-09-01T09:00:00.000Z",
    expiresAt: "2026-09-04T09:00:00.000Z",
    ...overrides,
  };
}

describe("renderDeferrals", () => {
  /**
   * @case An instance with nothing deferred
   * @preconditions An empty page
   * @expectedResult A sentence rather than an empty table, so the answer reads as "nothing is waiting" instead of a rendering that failed
   */
  test("says so when nothing is deferred", () => {
    const page: OpsPage<OpsDeferralSummary> = { items: [] };

    expect(renderDeferrals(page, "pretty")).toBe("Nothing is deferred.");
  });

  /**
   * @case The waiting-for column carries the claim
   * @preconditions One unclaimed and one claimed deferral, both waiting
   * @expectedResult The claimed row says so. A claimed deferral is still waiting and is NOT resumable while the claim holds, so a reader who saw only the state would read it as available
   */
  test("marks a deferral whose delivery is claimed", () => {
    const out = renderDeferrals(
      { items: [waiting(), waiting({ id: "ex-2#0", claimed: true })] },
      "pretty",
    );

    expect(out).toMatch(/ex-1#0.*resume(?!.*claimed)/);
    expect(out).toContain("resume (claimed)");
  });

  /**
   * @case A settled deferral shows how it ended
   * @preconditions One settled row carrying an outcome
   * @expectedResult The outcome takes the same column, because "what it waits for" and "how it ended" are one question asked at two moments, and two columns would leave one blank on every row
   */
  test("shows the outcome of a settled deferral", () => {
    const out = renderDeferrals(
      {
        items: [
          waiting({
            state: "settled",
            outcome: { kind: "expired", at: "2026-09-04T09:00:00.000Z" },
          }),
        ],
      },
      "pretty",
    );

    expect(out).toContain("expired");
  });

  /**
   * @case A bounded page says how to read the rest
   * @preconditions A page carrying a nextCursor
   * @expectedResult The cursor is printed as the flag that continues, so a reader is never left taking one screen for the whole set. Absent when the page is the last one
   */
  test("names the cursor when there is another page", () => {
    const withMore = renderDeferrals(
      { items: [waiting()], nextCursor: "Y3Vyc29y" },
      "pretty",
    );
    const last = renderDeferrals({ items: [waiting()] }, "pretty");

    expect(withMore).toContain("--after Y3Vyc29y");
    expect(last).not.toContain("--after");
  });

  /**
   * @case raw is the ids and json is the whole envelope
   * @preconditions One page in each machine format
   * @expectedResult raw prints ids for a pipe; json carries the cursor too, because a script that pages needs it and raw has nowhere to put it
   */
  test("renders the machine formats", () => {
    const page = { items: [waiting()], nextCursor: "Y3Vyc29y" };

    expect(renderDeferrals(page, "raw")).toBe("ex-1#0");
    expect(JSON.parse(renderDeferrals(page, "json"))).toEqual(page);
  });
});

describe("renderDeferral", () => {
  /**
   * @case One settled deferral, resumed by somebody
   * @preconditions A record carrying an outcome with a reason and a subject
   * @expectedResult Every field is labelled on its own line, including who resumed it, which is what the receipt on the record is for
   */
  test("renders the outcome and who caused it", () => {
    const out = renderDeferral(
      waiting({
        state: "settled",
        outcome: {
          kind: "resumed",
          at: "2026-09-02T09:00:00.000Z",
          reason: "approved in the console",
          by: { subject: "jaco" },
        },
      }),
      "pretty",
    );

    expect(out).toContain("state       settled");
    expect(out).toContain("outcome     resumed at 2026-09-02T09:00:00.000Z");
    expect(out).toContain("reason      approved in the console");
    expect(out).toContain("resumed by  jaco");
  });

  /**
   * @case A waiting deferral has no outcome to show
   * @preconditions A waiting record
   * @expectedResult No outcome lines at all, rather than a row saying none: absent is what it is while the work is still waiting
   */
  test("omits the outcome while it is waiting", () => {
    const out = renderDeferral(waiting(), "pretty");

    expect(out).toContain("claimed     no");
    expect(out).not.toContain("outcome");
  });
});
