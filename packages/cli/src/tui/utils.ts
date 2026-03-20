export function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "\u2026" : str;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "-";
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

export function col(str: string, len: number): string {
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

export function formatDetails(_eventName: string, raw: string): string {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;

    const exStr =
      "exchangeId" in d ? `${String(d["exchangeId"]).slice(0, 8)}` : "";
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

export interface DetailColumns {
  step: string;
  adapter: string;
  exchange: string;
  duration: string;
  meta: string;
}

/**
 * Structured version of formatDetails that returns individual columns
 * so the component can control alignment per-column.
 */
export function formatDetailColumns(
  eventName: string,
  raw: string,
): DetailColumns {
  const empty: DetailColumns = {
    step: "",
    adapter: "",
    exchange: "",
    duration: "",
    meta: "",
  };
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
        step: "",
        adapter: qualifier,
        exchange,
        duration,
        meta: "",
      };
    }

    // Fallback
    return { ...empty, step: formatDetails(eventName, raw) };
  } catch {
    return { ...empty, step: raw };
  }
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
  return values.map((v) => blocks[Math.round((v / max) * 8)]).join("");
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
