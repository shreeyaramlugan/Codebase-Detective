// features/explorer/virtual.ts
//
// Fixed-row-height windowing used by the file tree and the source viewer, so
// large trees and large source files only render the rows that are visible.

export interface VisibleWindow {
  start: number;
  end: number; // exclusive
  offsetTop: number;
  totalHeight: number;
}

export function visibleWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 8,
): VisibleWindow {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeRow = Math.max(1, rowHeight);
  const first = Math.floor(Math.max(0, scrollTop) / safeRow);
  const visible = Math.ceil(Math.max(0, viewportHeight) / safeRow);

  const start = Math.min(safeTotal, Math.max(0, first - overscan));
  const end = Math.min(safeTotal, first + visible + overscan);

  return {
    start,
    end: Math.max(start, end),
    offsetTop: start * safeRow,
    totalHeight: safeTotal * safeRow,
  };
}

/** scrollTop that places `index` roughly a third of the way down the viewport. */
export function scrollTopForIndex(
  index: number,
  total: number,
  viewportHeight: number,
  rowHeight: number,
): number {
  const clamped = Math.min(Math.max(0, index), Math.max(0, total - 1));
  const target = clamped * rowHeight - Math.floor(viewportHeight / 3);
  const max = Math.max(0, total * rowHeight - viewportHeight);
  return Math.min(Math.max(0, target), max);
}
