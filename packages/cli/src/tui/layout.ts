/**
 * Vertical lines consumed by Panel chrome + table header + footer.
 * Breakdown: 2 (border top/bottom) + 2 (title + separator) + 1 (footer) + 1 (header row) = 6
 */
export const PANEL_TABLE_CHROME = 6;

/**
 * Vertical lines consumed by the exchange detail info panel above the events table.
 * Breakdown: PANEL_TABLE_CHROME + 3 (capability + exchange + status lines) = 9
 */
export const DETAIL_INFO_CHROME = 9;

/** Ctrl+j/k navigation step size. */
export const NAV_JUMP = 10;

/** Minimum visible rows in any scrollable table. */
export const MIN_VISIBLE_ROWS = 3;
