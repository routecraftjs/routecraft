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

export function formatDetails(_eventName: string, raw: string): string {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;

    // Step/operation events: show operation + adapter + duration
    if ("operation" in d && "routeId" in d) {
      const parts: string[] = [String(d["operation"])];
      if ("adapter" in d) parts.push(`(${d["adapter"]})`);
      if ("adapterId" in d) parts.push(`(${d["adapterId"]})`);
      if ("duration" in d) parts.push(formatDuration(d["duration"] as number));
      if (
        "metadata" in d &&
        typeof d["metadata"] === "object" &&
        d["metadata"] !== null
      ) {
        const meta = d["metadata"] as Record<string, unknown>;
        const keys = Object.keys(meta).slice(0, 2);
        if (keys.length > 0) {
          parts.push(keys.map((k) => `${k}=${meta[k]}`).join(" "));
        }
      }
      return parts.join(" ");
    }

    // Exchange events: show route + exchange ID + duration/error
    if ("routeId" in d && "exchangeId" in d) {
      const exId = String(d["exchangeId"]).slice(0, 8);
      const dur =
        "duration" in d ? ` ${formatDuration(d["duration"] as number)}` : "";
      const err = "error" in d ? " ERROR" : "";
      return `${d["routeId"]} ex=${exId}${dur}${err}`;
    }

    // Route lifecycle events
    if ("route" in d && typeof d["route"] === "object" && d["route"] !== null) {
      const route = d["route"] as {
        routeId?: string;
        definition?: { id?: string };
      };
      return `${route.routeId ?? route.definition?.id ?? "?"}`;
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
  const data = values.slice(0, maxWidth);
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
 * Compute scroll offset so the selected item stays visible within `visibleRows`.
 * Returns the start index of the visible window.
 */
export function scrollOffset(
  selectedIndex: number,
  totalItems: number,
  visibleRows: number,
): number {
  if (totalItems <= visibleRows) return 0;
  const half = Math.floor(visibleRows / 2);
  const offset = Math.max(0, selectedIndex - half);
  return Math.min(offset, totalItems - visibleRows);
}
