export function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "\u2026" : str;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "-";
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms === 0) return "<1ms";
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

export function col(str: string, len: number | undefined): string {
  if (len === undefined) return str;
  if (len <= 0) return "";
  if (str.length > len) return str.slice(0, len - 1) + "\u2026";
  return str.padEnd(len);
}

// Fixed column widths for the Details column so fields line up across rows.
// All event types share the same 4-column layout:
//   [col1: 10] [col2: 10] [exId: 12] [dur: 6] [extra]
// Step events:    operation  (adapter)  id…       dur   metadata
// Exchange events: routeId   (status)   id…       dur
const DET = {
  COL1: 10, // operation or routeId
  COL2: 10, // (adapter) or (err)/(reason)/(dropped)
  EX: 12, // "789003e7    "
  DUR: 6, // "1ms   " "10.0s "
} as const;

export interface DetailColumns {
  step: string;
  adapter: string;
  exchange: string;
  duration: string;
  meta: string;
}

/**
 * Parse a JSON event detail string into structured columns.
 * Shared normalizer used by both formatDetails and formatDetailColumns.
 */
function parseEventDetail(raw: string): DetailColumns | null {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;

    const exchange =
      "exchangeId" in d ? `${String(d["exchangeId"]).slice(0, 8)}` : "";
    const duration =
      "duration" in d ? formatDuration(d["duration"] as number) : "";

    // Step/operation events
    if ("operation" in d && "routeId" in d) {
      const adapter =
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
      return {
        step: String(d["operation"]),
        adapter,
        exchange,
        duration,
        meta,
      };
    }

    // Exchange events
    if ("routeId" in d && "exchangeId" in d) {
      const qualifier =
        "error" in d
          ? "(err)"
          : "reason" in d
            ? `(${String(d["reason"]).slice(0, 8)})`
            : "";
      return {
        step: String(d["routeId"]),
        adapter: qualifier,
        exchange,
        duration,
        meta: "",
      };
    }

    // Route lifecycle events
    if ("route" in d && typeof d["route"] === "object" && d["route"] !== null) {
      const route = d["route"] as {
        routeId?: string;
        definition?: { id?: string };
      };
      return {
        step: route.routeId ?? route.definition?.id ?? "?",
        adapter: "",
        exchange: "",
        duration: "",
        meta: "",
      };
    }

    // Plugin events
    if ("pluginId" in d) {
      return {
        step: `plugin=${d["pluginId"]}`,
        adapter: "",
        exchange: "",
        duration: "",
        meta: "",
      };
    }

    // Error events
    if ("error" in d) {
      const err = d["error"];
      const msg =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: string }).message)
          : String(err);
      return {
        step: msg,
        adapter: "",
        exchange: "",
        duration: "",
        meta: "",
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function formatDetails(_eventName: string, raw: string): string {
  const parsed = parseEventDetail(raw);
  if (!parsed) {
    return raw.length > 100 ? raw.slice(0, 97) + "..." : raw;
  }

  // Non-columnar events (plugin, route lifecycle, error) have no exchange/duration
  if (!parsed.exchange && !parsed.duration && !parsed.adapter) {
    return parsed.step;
  }

  return [
    col(parsed.step, DET.COL1),
    col(parsed.adapter, DET.COL2),
    col(parsed.exchange, DET.EX),
    col(parsed.duration, DET.DUR),
    parsed.meta,
  ]
    .join(" ")
    .trimEnd();
}

/**
 * Structured version of formatDetails that returns individual columns
 * so the component can control alignment per-column.
 */
export function formatDetailColumns(
  _eventName: string,
  raw: string,
): DetailColumns {
  const parsed = parseEventDetail(raw);
  if (!parsed) {
    return { step: raw, adapter: "", exchange: "", duration: "", meta: "" };
  }
  return parsed;
}

/**
 * Render a single-line sparkline from an array of values.
 * Uses Unicode block characters (▁▂▃▄▅▆▇█).
 * Empty/zero-only input returns spaces of the same length.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
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
  const max = Math.max(...values, 1);
  return values
    .map((v) => {
      const idx = Math.max(0, Math.min(8, Math.round((v / max) * 8)));
      return blocks[Number.isFinite(idx) ? idx : 0];
    })
    .join("");
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
  if (visibleRows <= 0) return currentOffset;
  if (selected < currentOffset) return selected;
  if (selected >= currentOffset + visibleRows)
    return selected - visibleRows + 1;
  return currentOffset;
}
