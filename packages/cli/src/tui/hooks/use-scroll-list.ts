import { useState, useCallback } from "react";
import { adjustScrollOffset } from "../utils.js";

export interface ScrollListState {
  selectedIndex: number;
  scrollOffset: number;
  /** Move selection by delta (positive = down, negative = up). */
  moveBy: (delta: number, listLength: number, visibleRows: number) => void;
  /** Jump to an absolute index. */
  moveTo: (index: number, listLength: number, visibleRows: number) => void;
  /** Reset selection and scroll to the beginning. */
  reset: () => void;
}

/**
 * Manages a paired (selectedIndex, scrollOffset) state for scrollable lists.
 * Keeps the selected item visible without centering.
 *
 * `listLength` and `visibleRows` are passed at call time (not stored)
 * because they change every render (terminal resize, data load).
 */
export function useScrollList(initialIndex = 0): ScrollListState {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [scrollOffset, setScrollOffset] = useState(0);

  const moveTo = useCallback(
    (index: number, listLength: number, visibleRows: number) => {
      const clamped = Math.max(0, Math.min(index, listLength - 1));
      setSelectedIndex(clamped);
      setScrollOffset((off) => adjustScrollOffset(clamped, off, visibleRows));
    },
    [],
  );

  const moveBy = useCallback(
    (delta: number, listLength: number, visibleRows: number) => {
      setSelectedIndex((prev) => {
        const next = Math.max(0, Math.min(prev + delta, listLength - 1));
        setScrollOffset((off) => adjustScrollOffset(next, off, visibleRows));
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => {
    setSelectedIndex(0);
    setScrollOffset(0);
  }, []);

  return { selectedIndex, scrollOffset, moveBy, moveTo, reset };
}
