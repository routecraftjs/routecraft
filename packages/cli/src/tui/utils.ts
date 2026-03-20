export function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "\u2026" : str;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function statusColor(status: string): string {
  switch (status) {
    case "completed":
    case "started":
      return "green";
    case "failed":
      return "red";
    case "stopped":
    case "dropped":
      return "yellow";
    default:
      return "white";
  }
}

export function col(str: string, len: number): string {
  if (len <= 0) return "";
  if (str.length > len) return str.slice(0, len - 1) + "\u2026";
  return str.padEnd(len);
}

// Fixed column widths for the Details column so fields line up across rows.
// All event types share the same 4-column layout:
//   [col1: 10] [col2: 10] [ex=: 12] [dur: 6] [extra]
// Step events:    operation  (adapter)  ex=…      dur   metadata
// Exchange events: routeId   (status)   ex=…      dur
const DET = {
  COL1: 10, // operation or routeId
  COL2: 10, // (adapter) or (err)/(reason)/(dropped)
  EX: 12, // "ex=789003e7 "
  DUR: 6, // "1ms   " "10.0s "
} as const;

export function formatDetails(_eventName: string, raw: string): string {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;

    const exStr =
      "exchangeId" in d ? `ex=${String(d["exchangeId"]).slice(0, 8)}` : "";
    const durStr =
      "duration" in d ? formatDuration(d["duration"] as number) : "";

    // Step/operation events
    if ("operation" in d && "routeId" in d) {
      const adapterRaw =
        "adapter" in d
          ? `(${d["adapter"]})`
          : "adapterId" in d
            ? `(${d["adapterId"]})`
            : "";
      let meta = "";
      if (
        "metadata" in d &&
        typeof d["metadata"] === "object" &&
        d["metadata"] !== null
      ) {
        const m = d["metadata"] as Record<string, unknown>;
        const keys = Object.keys(m).slice(0, 2);
        if (keys.length > 0) meta = keys.map((k) => `${k}=${m[k]}`).join(" ");
      }
      return [
        col(String(d["operation"]), DET.COL1),
        col(adapterRaw, DET.COL2),
        col(exStr, DET.EX),
        col(durStr, DET.DUR),
        meta,
      ]
        .join(" ")
        .trimEnd();
    }

    // Exchange events -- col2 shows qualifier: (err), (dropped), (reason), or empty
    if ("routeId" in d && "exchangeId" in d) {
      const qualifier =
        "error" in d
          ? "(err)"
          : "reason" in d
            ? `(${String(d["reason"]).slice(0, 8)})`
            : "";
      return [
        col(String(d["routeId"]), DET.COL1),
        col(qualifier, DET.COL2),
        col(exStr, DET.EX),
        col(durStr, DET.DUR),
      ]
        .join(" ")
        .trimEnd();
    }

    // Route lifecycle events
    if ("route" in d && typeof d["route"] === "object" && d["route"] !== null) {
      const route = d["route"] as {
        routeId?: string;
        definition?: { id?: string };
      };
      return route.routeId ?? route.definition?.id ?? "?";
    }

    if ("pluginId" in d) return `plugin=${d["pluginId"]}`;
    if ("error" in d) {
      const err = d["error"];
      if (typeof err === "object" && err !== null && "message" in err)
        return String((err as { message: string }).message);
      return String(err);
    }
    return raw.length > 100 ? raw.slice(0, 97) + "..." : raw;
  } catch {
    return raw;
  }
}

/**
 * Render a multi-row bar chart from bucket values.
 * Each column is one bucket; rows build from bottom to top.
 * Returns an array of strings, one per row (top row first).
 */
export function barChart(
  values: number[],
  maxWidth: number,
  chartHeight: number,
): string[] {
  if (values.length === 0) {
    return Array.from({ length: chartHeight }, () => " ".repeat(maxWidth));
  }
  const data =
    values.length <= maxWidth
      ? values
      : Array.from({ length: maxWidth }, (_, i) => {
          const start = Math.floor((i * values.length) / maxWidth);
          const end = Math.floor(((i + 1) * values.length) / maxWidth);
          return Math.max(...values.slice(start, end), 0);
        });
  const max = Math.max(...data, 1);

  const rows: string[] = [];
  for (let row = chartHeight - 1; row >= 0; row--) {
    const threshold = (row / chartHeight) * max;
    let line = "";
    for (const v of data) {
      if (v > threshold) {
        const cellFill = Math.min((v - threshold) / (max / chartHeight), 1);
        const blocks = [
          " ",
          "\u2581",
          "\u2582",
          "\u2583",
          "\u2584",
          "\u2585",
          "\u2586",
          "\u2587",
          "\u2588",
        ];
        line += blocks[Math.round(cellFill * 8)];
      } else {
        line += " ";
      }
    }
    rows.push(line.padEnd(maxWidth));
  }
  return rows;
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Adjust scroll offset so the selected item stays visible without centering.
 * The cursor moves freely within the visible window; the list only scrolls
 * when the cursor hits the top or bottom edge.
 *
 * @param selected - New selected index
 * @param currentOffset - Current scroll offset (tracked as state by the caller)
 * @param visibleRows - Number of rows visible in the list
 * @returns Updated scroll offset
 */
export function adjustScrollOffset(
  selected: number,
  currentOffset: number,
  visibleRows: number,
): number {
  if (selected < currentOffset) return selected;
  if (selected >= currentOffset + visibleRows)
    return selected - visibleRows + 1;
  return currentOffset;
}

/** @deprecated Use adjustScrollOffset with tracked state instead. */
export function scrollOffset(
  selectedIndex: number,
  totalItems: number,
  visibleRows: number,
): number {
  if (totalItems <= visibleRows) return 0;
  return adjustScrollOffset(selectedIndex, 0, visibleRows);
}
