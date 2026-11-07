// components/explorer/FileTree.tsx
"use client";

import { useEffect, useRef, useState } from "react";

import {
  describeAvailability,
  fileTypeBadge,
  type TreeRow,
} from "@/features/explorer/tree/file-tree";
import { scrollTopForIndex, visibleWindow } from "@/features/explorer/virtual";

const ROW_HEIGHT = 28;

type Props = {
  rows: TreeRow[];
  selectedPath: string | null;
  height: number;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
};

const dotClass: Record<string, string> = {
  analysed: "bg-emerald-400",
  analysed_with_errors: "bg-amber-400",
  config: "bg-stone-500",
  stored: "bg-stone-500",
  skipped: "bg-amber-600",
  failed: "bg-red-500",
  unavailable: "bg-red-500",
};

/**
 * Virtualised tree: only the visible rows are in the DOM, so a repository
 * with tens of thousands of files stays responsive. Collapsed folders add no
 * rows at all.
 */
export default function FileTree({
  rows,
  selectedPath,
  height,
  onToggle,
  onSelect,
}: Props) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Reveal the selected file when it changes (e.g. from search or a symbol).
  useEffect(() => {
    if (!selectedPath || !scroller.current) return;
    const index = rows.findIndex((row) => row.node.path === selectedPath);
    if (index < 0) return;

    const top = scroller.current.scrollTop;
    const bottom = top + height - ROW_HEIGHT;
    const y = index * ROW_HEIGHT;
    if (y < top || y > bottom) {
      scroller.current.scrollTop = scrollTopForIndex(
        index,
        rows.length,
        height,
        ROW_HEIGHT,
      );
    }
    // Only when the selection changes, not on every expand/collapse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  const window = visibleWindow(rows.length, scrollTop, height, ROW_HEIGHT, 10);

  return (
    <div
      ref={scroller}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      style={{ height }}
      className="overflow-auto"
      role="tree"
      aria-label="Repository files"
    >
      <div style={{ height: window.totalHeight, position: "relative" }}>
        <div style={{ transform: `translateY(${window.offsetTop}px)` }}>
          {rows
            .slice(window.start, window.end)
            .map(({ node, depth, expanded }) => {
              const selected = node.path === selectedPath;
              const indent = { paddingLeft: 8 + depth * 14 };

              if (node.kind === "dir") {
                return (
                  <button
                    key={`d:${node.path}`}
                    type="button"
                    role="treeitem"
                    aria-expanded={expanded}
                    onClick={() => onToggle(node.path)}
                    style={{ ...indent, height: ROW_HEIGHT }}
                    className="flex w-full items-center gap-2 pr-2 text-left text-sm text-stone-300 hover:bg-stone-800/70"
                  >
                    <span
                      className="w-3 text-xs text-stone-500"
                      aria-hidden="true"
                    >
                      {expanded ? "▾" : "▸"}
                    </span>
                    <span className="truncate">{node.name}</span>
                    <span className="ml-auto text-[10px] text-stone-600">
                      {node.fileCount}
                    </span>
                  </button>
                );
              }

              const info = describeAvailability(node.entry);
              const muted = !info.viewable;

              return (
                <button
                  key={`f:${node.path}`}
                  type="button"
                  role="treeitem"
                  aria-selected={selected}
                  aria-label={`${node.name}, ${info.label}`}
                  onClick={() => onSelect(node.path)}
                  title={info.detail ?? node.path}
                  style={{ ...indent, height: ROW_HEIGHT }}
                  className={`flex w-full items-center gap-2 pr-2 text-left text-sm ${
                    selected
                      ? "bg-orange-500/10 text-orange-200"
                      : muted
                        ? "text-stone-500 hover:bg-stone-800/50"
                        : "text-stone-300 hover:bg-stone-800/70"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass[info.availability]}`}
                    aria-hidden="true"
                  />
                  <span className="w-7 shrink-0 text-[9px] font-semibold text-stone-500">
                    {fileTypeBadge(node.entry.extension, node.name)}
                  </span>
                  <span className={`truncate ${muted ? "italic" : ""}`}>
                    {node.name}
                  </span>
                  {muted && (
                    <span className="ml-auto shrink-0 text-[10px] uppercase text-amber-600">
                      {info.label}
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}
