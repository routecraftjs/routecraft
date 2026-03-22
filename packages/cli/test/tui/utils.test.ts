import { describe, test, expect } from "vitest";
import {
  truncate,
  formatDuration,
  statusColor,
  col,
  formatDetails,
  formatDetailColumns,
  sparkline,
  fmtNum,
  adjustScrollOffset,
} from "../../src/tui/utils.js";

describe("truncate", () => {
  /**
   * @case Returns empty string when maxLen is 0
   * @preconditions Non-empty input string
   * @expectedResult Empty string returned
   */
  test("returns empty for maxLen 0", () => {
    expect(truncate("hello", 0)).toBe("");
  });

  /**
   * @case Returns string unchanged when shorter than maxLen
   * @preconditions String shorter than limit
   * @expectedResult Original string returned
   */
  test("returns string unchanged when shorter", () => {
    expect(truncate("hi", 5)).toBe("hi");
  });

  /**
   * @case Returns string unchanged when equal to maxLen
   * @preconditions String length equals limit
   * @expectedResult Original string returned
   */
  test("returns string unchanged when equal", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  /**
   * @case Truncates with ellipsis when longer than maxLen
   * @preconditions String longer than limit
   * @expectedResult Truncated string ending with ellipsis character
   */
  test("truncates with ellipsis when longer", () => {
    expect(truncate("hello world", 5)).toBe("hell\u2026");
  });
});

describe("formatDuration", () => {
  /**
   * @case Returns dash for null
   * @preconditions null input
   * @expectedResult "-"
   */
  test("returns dash for null", () => {
    expect(formatDuration(null)).toBe("-");
  });

  /**
   * @case Returns <1ms for zero
   * @preconditions 0 input
   * @expectedResult "<1ms"
   */
  test("returns <1ms for zero", () => {
    expect(formatDuration(0)).toBe("<1ms");
  });

  /**
   * @case Formats sub-second durations in milliseconds
   * @preconditions Value under 1000
   * @expectedResult "Xms" format
   */
  test("formats sub-second as ms", () => {
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  /**
   * @case Formats second-plus durations with one decimal
   * @preconditions Value >= 1000
   * @expectedResult "X.Xs" format
   */
  test("formats seconds with decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(3200)).toBe("3.2s");
  });
});

describe("statusColor", () => {
  /**
   * @case Maps each known status to its color
   * @preconditions Known status strings
   * @expectedResult Correct color for each status
   */
  test("maps known statuses", () => {
    expect(statusColor("completed")).toBe("green");
    expect(statusColor("started")).toBe("green");
    expect(statusColor("failed")).toBe("red");
    expect(statusColor("stopped")).toBe("yellow");
    expect(statusColor("dropped")).toBe("yellow");
  });

  /**
   * @case Returns white for unknown status
   * @preconditions Unknown status string
   * @expectedResult "white"
   */
  test("returns white for unknown", () => {
    expect(statusColor("unknown")).toBe("white");
  });
});

describe("col", () => {
  /**
   * @case Returns empty string when len is 0
   * @preconditions len=0
   * @expectedResult Empty string
   */
  test("returns empty for len 0", () => {
    expect(col("hello", 0)).toBe("");
  });

  /**
   * @case Pads shorter string to exact length
   * @preconditions String shorter than len
   * @expectedResult Padded to len with spaces
   */
  test("pads shorter string", () => {
    expect(col("hi", 5)).toBe("hi   ");
    expect(col("hi", 5).length).toBe(5);
  });

  /**
   * @case Truncates longer string with ellipsis
   * @preconditions String longer than len
   * @expectedResult Truncated with ellipsis, exact len
   */
  test("truncates with ellipsis", () => {
    expect(col("hello world", 5)).toBe("hell\u2026");
    expect(col("hello world", 5).length).toBe(5);
  });

  /**
   * @case Returns exact string when length matches
   * @preconditions String length equals len
   * @expectedResult Original string
   */
  test("returns exact when equal", () => {
    expect(col("hello", 5)).toBe("hello");
  });
});

describe("formatDetailColumns", () => {
  /**
   * @case Parses step/operation event details
   * @preconditions JSON with operation, routeId, adapter, exchangeId, duration
   * @expectedResult Populated step, adapter, exchange, and duration fields
   */
  test("parses step event", () => {
    const details = JSON.stringify({
      operation: "enrich",
      routeId: "my-route",
      adapter: "http",
      exchangeId: "abcdef1234567890",
      duration: 150,
    });
    const result = formatDetailColumns("route:my-route:step:started", details);
    expect(result.step).toBe("enrich");
    expect(result.adapter).toBe("(http)");
    expect(result.exchange).toBe("abcdef12");
    expect(result.duration).toBe("150ms");
  });

  /**
   * @case Parses exchange event with empty step
   * @preconditions JSON with routeId and exchangeId but no operation
   * @expectedResult Empty step, exchange ID truncated to 8 chars
   */
  test("parses exchange event with routeId in step", () => {
    const details = JSON.stringify({
      routeId: "my-route",
      exchangeId: "abcdef1234567890",
      duration: 3200,
    });
    const result = formatDetailColumns(
      "route:my-route:exchange:completed",
      details,
    );
    expect(result.step).toBe("my-route");
    expect(result.exchange).toBe("abcdef12");
    expect(result.duration).toBe("3.2s");
  });

  /**
   * @case Parses exchange event with error qualifier
   * @preconditions JSON with routeId, exchangeId, and error
   * @expectedResult adapter field shows "(err)"
   */
  test("shows error qualifier for failed exchanges", () => {
    const details = JSON.stringify({
      routeId: "my-route",
      exchangeId: "abcdef12",
      error: "timeout",
      duration: 5000,
    });
    const result = formatDetailColumns(
      "route:my-route:exchange:failed",
      details,
    );
    expect(result.adapter).toBe("(err)");
  });

  /**
   * @case Returns raw string in step field for malformed JSON
   * @preconditions Invalid JSON string
   * @expectedResult step contains the raw string, other fields empty
   */
  test("handles malformed JSON", () => {
    const result = formatDetailColumns("unknown", "not-json");
    expect(result.step).toBe("not-json");
    expect(result.adapter).toBe("");
    expect(result.exchange).toBe("");
    expect(result.duration).toBe("");
  });

  /**
   * @case Extracts metadata from step events
   * @preconditions JSON with operation and metadata object
   * @expectedResult meta field contains key=value pairs
   */
  test("extracts metadata from step events", () => {
    const details = JSON.stringify({
      operation: "transform",
      routeId: "my-route",
      adapterId: "inline",
      exchangeId: "abcdef12",
      metadata: { format: "json", size: 42 },
    });
    const result = formatDetailColumns("route:my-route:step:started", details);
    expect(result.adapter).toBe("(inline)");
    expect(result.meta).toContain("format=json");
    expect(result.meta).toContain("size=42");
  });
});

describe("formatDetails", () => {
  /**
   * @case Formats route lifecycle events
   * @preconditions JSON with route.definition.id
   * @expectedResult Route ID string
   */
  test("formats route lifecycle", () => {
    const details = JSON.stringify({
      route: { definition: { id: "my-route" } },
    });
    expect(formatDetails("route:registered", details)).toBe("my-route");
  });

  /**
   * @case Formats plugin events
   * @preconditions JSON with pluginId
   * @expectedResult "plugin=<id>" string
   */
  test("formats plugin events", () => {
    const details = JSON.stringify({ pluginId: "telemetry" });
    expect(formatDetails("plugin:event", details)).toBe("plugin=telemetry");
  });

  /**
   * @case Returns raw string for malformed JSON
   * @preconditions Invalid JSON
   * @expectedResult Raw input string
   */
  test("returns raw for malformed JSON", () => {
    expect(formatDetails("unknown", "not-json")).toBe("not-json");
  });
});

describe("adjustScrollOffset", () => {
  /**
   * @case Returns current offset when selected is within visible window
   * @preconditions Selected index between offset and offset+visibleRows
   * @expectedResult Unchanged offset
   */
  test("keeps offset when within window", () => {
    expect(adjustScrollOffset(5, 3, 10)).toBe(3);
  });

  /**
   * @case Scrolls up when selected is above visible window
   * @preconditions Selected index less than current offset
   * @expectedResult Offset set to selected index
   */
  test("scrolls up when above window", () => {
    expect(adjustScrollOffset(2, 5, 10)).toBe(2);
  });

  /**
   * @case Scrolls down when selected is below visible window
   * @preconditions Selected index >= offset + visibleRows
   * @expectedResult Offset adjusted so selected is last visible row
   */
  test("scrolls down when below window", () => {
    expect(adjustScrollOffset(15, 3, 10)).toBe(6);
  });
});

describe("sparkline", () => {
  /**
   * @case Returns empty string for empty array
   * @preconditions Empty input
   * @expectedResult Empty string
   */
  test("returns empty for empty array", () => {
    expect(sparkline([])).toBe("");
  });

  /**
   * @case Returns spaces for all-zero values
   * @preconditions Array of zeros
   * @expectedResult String of spaces
   */
  test("returns spaces for all zeros", () => {
    const result = sparkline([0, 0, 0]);
    expect(result).toBe("   ");
  });

  /**
   * @case Returns full blocks for max values
   * @preconditions Array where all values equal the max
   * @expectedResult String of full block characters
   */
  test("renders full blocks for max values", () => {
    const result = sparkline([10, 10, 10]);
    expect(result).toBe("\u2588\u2588\u2588");
  });

  /**
   * @case Renders mixed values with varying block heights
   * @preconditions Array with 0, mid, and max values
   * @expectedResult Different block characters reflecting relative values
   */
  test("renders mixed values", () => {
    const result = sparkline([0, 5, 10]);
    expect(result.length).toBe(3);
    expect(result[0]).toBe(" ");
    expect(result[2]).toBe("\u2588");
  });
});

describe("fmtNum", () => {
  /**
   * @case Formats numbers with thousands separator
   * @preconditions Various numeric values
   * @expectedResult Locale-formatted strings
   */
  test("formats with separator", () => {
    expect(fmtNum(0)).toBe("0");
    expect(fmtNum(999)).toBe("999");
    expect(fmtNum(1000)).toBe("1,000");
    expect(fmtNum(1000000)).toBe("1,000,000");
  });
});
