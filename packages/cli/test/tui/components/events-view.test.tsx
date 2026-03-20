import { render } from "ink-testing-library";
import { describe, test, expect } from "vitest";
import { EventsView } from "../../../src/tui/components/events-view.js";
import { makeEvent } from "../../tui/fixtures.js";

describe("EventsView", () => {
  /**
   * @case Renders EVENTS title with total count
   * @preconditions Two events are provided
   * @expectedResult Output contains "EVENTS" and "(2 total)"
   */
  test("renders EVENTS title with count", () => {
    const events = [
      makeEvent({ id: 1, eventName: "exchange:started" }),
      makeEvent({ id: 2, eventName: "exchange:completed" }),
    ];
    const { lastFrame } = render(
      <EventsView
        events={events}
        selectedIndex={0}
        scrollOffset={0}
        width={80}
        height={20}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("EVENTS");
    expect(frame).toContain("2 total");
  });

  /**
   * @case Renders event names in the table
   * @preconditions Events with distinct eventName values
   * @expectedResult Both event names appear in the output
   */
  test("renders event names", () => {
    const events = [
      makeEvent({ id: 1, eventName: "ev:start" }),
      makeEvent({ id: 2, eventName: "ev:done" }),
    ];
    const { lastFrame } = render(
      <EventsView
        events={events}
        selectedIndex={0}
        scrollOffset={0}
        width={120}
        height={20}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("ev:start");
    expect(frame).toContain("ev:done");
  });

  /**
   * @case Shows empty state when no events are provided
   * @preconditions Empty events array
   * @expectedResult Output contains the empty message "No events recorded yet."
   */
  test("shows empty state when no events", () => {
    const { lastFrame } = render(
      <EventsView
        events={[]}
        selectedIndex={-1}
        scrollOffset={0}
        width={80}
        height={20}
      />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain("No events recorded yet.");
  });
});
