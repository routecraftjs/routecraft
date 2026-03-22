import { render } from "ink-testing-library";
import { describe, test, expect } from "vitest";
import { CenterExchangeList } from "../../../src/tui/components/center-exchange-list.js";
import { makeExchange, makeRoute } from "../../tui/fixtures.js";

describe("CenterExchangeList", () => {
  /**
   * @case Renders exchange IDs in the list
   * @preconditions Two exchanges with different IDs
   * @expectedResult Both exchange IDs appear in the output
   */
  test("renders exchange IDs", () => {
    const exchanges = [
      makeExchange({ id: "ex-aaa" }),
      makeExchange({ id: "ex-bbb" }),
    ];
    const { lastFrame } = render(
      <CenterExchangeList
        capabilityId="test-route"
        route={makeRoute()}
        exchanges={exchanges}
        selectedIndex={0}
        scrollOffset={0}
        width={80}
        height={30}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("ex-aaa");
    expect(frame).toContain("ex-bbb");
  });

  /**
   * @case Shows status text for each exchange
   * @preconditions One completed and one failed exchange
   * @expectedResult Both "completed" and "failed" status strings appear
   */
  test("shows status text", () => {
    const exchanges = [
      makeExchange({ id: "ex-1", status: "completed" }),
      makeExchange({ id: "ex-2", status: "failed" }),
    ];
    const { lastFrame } = render(
      <CenterExchangeList
        capabilityId="test-route"
        route={makeRoute()}
        exchanges={exchanges}
        selectedIndex={0}
        scrollOffset={0}
        width={80}
        height={30}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("completed");
    expect(frame).toContain("failed");
  });

  /**
   * @case Shows duration for exchanges
   * @preconditions Exchange with durationMs=1500 (should format as "1.5s")
   * @expectedResult "1.5s" appears in the output
   */
  test("shows duration", () => {
    const exchanges = [makeExchange({ id: "ex-1", durationMs: 1500 })];
    const { lastFrame } = render(
      <CenterExchangeList
        capabilityId="test-route"
        route={makeRoute()}
        exchanges={exchanges}
        selectedIndex={0}
        scrollOffset={0}
        width={80}
        height={30}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("1.5s");
  });
});
