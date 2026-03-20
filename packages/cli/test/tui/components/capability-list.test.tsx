import { render } from "ink-testing-library";
import { describe, test, expect } from "vitest";
import { CapabilityList } from "../../../src/tui/components/capability-list.js";
import { makeRoute } from "../../tui/fixtures.js";

describe("CapabilityList", () => {
  /**
   * @case Renders route IDs in the list
   * @preconditions Two routes with distinct IDs are provided
   * @expectedResult Both route IDs appear in the output
   */
  test("renders route IDs", () => {
    const routes = [
      makeRoute({ id: "route-alpha" }),
      makeRoute({ id: "route-beta" }),
    ];
    const { lastFrame } = render(
      <CapabilityList
        routes={routes}
        selectedIndex={0}
        listOffset={0}
        visibleRows={10}
        width={20}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("route-alpha");
    expect(frame).toContain("route-beta");
  });

  /**
   * @case Shows selection indicator on the selected route
   * @preconditions selectedIndex=1 with two routes
   * @expectedResult A ">" character appears on the line with the selected route
   */
  test("shows selection indicator on selected route", () => {
    const routes = [
      makeRoute({ id: "route-one" }),
      makeRoute({ id: "route-two" }),
    ];
    const { lastFrame } = render(
      <CapabilityList
        routes={routes}
        selectedIndex={1}
        listOffset={0}
        visibleRows={10}
        width={20}
      />,
    );
    const frame = lastFrame()!;
    // The selected row has ">" prefix
    const lines = frame.split("\n");
    const selectedLine = lines.find((l) => l.includes("route-two"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain(">");
  });

  /**
   * @case Shows pagination indicator when routes exceed visible rows
   * @preconditions 5 routes but only 3 visibleRows
   * @expectedResult A pagination indicator like "1/5" appears in the output
   */
  test("shows pagination when routes exceed visible rows", () => {
    const routes = Array.from({ length: 5 }, (_, i) =>
      makeRoute({ id: `route-${i}` }),
    );
    const { lastFrame } = render(
      <CapabilityList
        routes={routes}
        selectedIndex={0}
        listOffset={0}
        visibleRows={3}
        width={20}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("1/5");
  });
});
