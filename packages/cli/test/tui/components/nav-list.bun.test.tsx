import { render } from "ink-testing-library";
import { describe, expect, test } from "bun:test";
import { NavList } from "../../../src/tui/components/nav-list.js";
import { makeRoute } from "../../tui/fixtures.js";
import type { RouteSummary } from "../../../src/tui/types.js";

function renderRoutes(
  routes: RouteSummary[],
  props?: Partial<{ selectedIndex: number; visibleRows: number }>,
) {
  return render(
    <NavList
      items={routes}
      itemKey={(r) => r.id}
      label={(r) => r.id}
      dotColor={() => "green"}
      emptyText="No capabilities"
      selectedIndex={props?.selectedIndex ?? 0}
      listOffset={0}
      visibleRows={props?.visibleRows ?? 10}
      width={20}
    />,
  );
}

describe("NavList", () => {
  /**
   * @case Renders item labels in the list
   * @preconditions Two routes with distinct IDs are provided
   * @expectedResult Both route IDs appear in the output
   */
  test("renders item labels", () => {
    const routes = [
      makeRoute({ id: "route-alpha" }),
      makeRoute({ id: "route-beta" }),
    ];
    const { lastFrame } = renderRoutes(routes);
    const frame = lastFrame()!;
    expect(frame).toContain("route-alpha");
    expect(frame).toContain("route-beta");
  });

  /**
   * @case Shows selection indicator on the selected item
   * @preconditions selectedIndex=1 with two routes
   * @expectedResult A ">" character appears on the line with the selected route
   */
  test("shows selection indicator on selected item", () => {
    const routes = [
      makeRoute({ id: "route-one" }),
      makeRoute({ id: "route-two" }),
    ];
    const { lastFrame } = renderRoutes(routes, { selectedIndex: 1 });
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    const selectedLine = lines.find((l) => l.includes("route-two"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain(">");
  });

  /**
   * @case Shows pagination indicator when items exceed visible rows
   * @preconditions 5 routes but only 3 visibleRows
   * @expectedResult A pagination indicator like "1/5" appears in the output
   */
  test("shows pagination when items exceed visible rows", () => {
    const routes = Array.from({ length: 5 }, (_, i) =>
      makeRoute({ id: `route-${i}` }),
    );
    const { lastFrame } = renderRoutes(routes, { visibleRows: 3 });
    const frame = lastFrame()!;
    expect(frame).toContain("1/5");
  });

  /**
   * @case Shows the empty text when there are no items
   * @preconditions Empty items array
   * @expectedResult The provided emptyText is rendered
   */
  test("shows empty text when there are no items", () => {
    const { lastFrame } = renderRoutes([]);
    expect(lastFrame()!).toContain("No capabilities");
  });
});
