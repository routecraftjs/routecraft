import { render } from "ink-testing-library";
import { describe, test, expect } from "vitest";
import { RouteHeader } from "../../../src/tui/components/route-header.js";
import { makeRoute } from "../../tui/fixtures.js";

describe("RouteHeader", () => {
  /**
   * @case Renders route ID prefixed with "Capability:"
   * @preconditions A route with id "my-route" is provided
   * @expectedResult Output contains "Capability:" and "my-route"
   */
  test("renders route ID", () => {
    const route = makeRoute({ id: "my-route" });
    const { lastFrame } = render(<RouteHeader route={route} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Capability:");
    expect(frame).toContain("my-route");
  });

  /**
   * @case Shows exchange count
   * @preconditions Route has totalExchanges set to 42
   * @expectedResult Output contains "Exchanges:" and "42"
   */
  test("shows exchange counts", () => {
    const route = makeRoute({ totalExchanges: 42 });
    const { lastFrame } = render(<RouteHeader route={route} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Exchanges:");
    expect(frame).toContain("42");
  });

  /**
   * @case Shows error and dropped counts when non-zero
   * @preconditions Route has failedExchanges=3 and droppedExchanges=2
   * @expectedResult Output contains "Errors:" with "3" and "Dropped:" with "2"
   */
  test("shows error and dropped counts when non-zero", () => {
    const route = makeRoute({ failedExchanges: 3, droppedExchanges: 2 });
    const { lastFrame } = render(<RouteHeader route={route} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Errors:");
    expect(frame).toContain("3");
    expect(frame).toContain("Dropped:");
    expect(frame).toContain("2");
  });

  /**
   * @case Formats average duration using formatDuration
   * @preconditions Route has avgDurationMs=1500 (should display as "1.5s")
   * @expectedResult Output contains "Avg:" and "1.5s"
   */
  test("formats average duration", () => {
    const route = makeRoute({ avgDurationMs: 1500 });
    const { lastFrame } = render(<RouteHeader route={route} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Avg:");
    expect(frame).toContain("1.5s");
  });
});
