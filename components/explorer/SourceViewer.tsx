// components/explorer/SourceViewer.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  highlightSource,
  type TokenKind,
} from "@/features/explorer/source/highlight";
import { scrollTopForIndex, visibleWindow } from "@/features/explorer/virtual";

import { Badge, ErrorBox, Spinner, formatBytes, inputClass } from "./ui";
import { readApiError } from "./useApi";

const ROW_HEIGHT = 20;

const tokenClass: Record<TokenKind, string> = {
  plain: "text-stone-200",
  keyword: "text-orange-300",
  string: "text-emerald-300",
  comment: "text-stone-500 italic",
  number: "text-sky-300",
  literal: "text-purple-300",
};

type Props = {
  repositoryId: string;
  snapshotId: string;
  path: string;
  /** Hash the analysis recorded for this file; compared with what is served. */
  analysisContentHash?: string | null;
  /** 1-based line to reveal. */
  line?: number | null;
  /** Inclusive, 1-based range to emphasise (e.g. a symbol's extent). */
  range?: { startLine: number; endLine: number } | null;
  height?: number;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string; etag: string | null; bytes: number };

/**
 * Renders repository source as inert text. Content comes only from the
 * owner-scoped content endpoint, is tokenised into plain data and drawn as
 * React text nodes: it is never parsed as HTML and never executed.
 */
export default function SourceViewer({
  repositoryId,
  snapshotId,
  path,
  analysisContentHash = null,
  line = null,
  range = null,
  height = 560,
}: Props) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [scrollTop, setScrollTop] = useState(0);
  const [jump, setJump] = useState("");
  const [attempt, setAttempt] = useState(0);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    setScrollTop(0);

    const url =
      `/api/repositories/${encodeURIComponent(repositoryId)}` +
      `/snapshots/${encodeURIComponent(snapshotId)}/files/content` +
      `?path=${encodeURIComponent(path)}`;

    fetch(url, { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await readApiError(response));
        }
        const text = await response.text();
        return {
          text,
          etag: response.headers.get("ETag"),
          bytes: Number(response.headers.get("Content-Length")) || text.length,
        };
      })
      .then((result) => {
        if (!controller.signal.aborted) setLoad({ status: "ready", ...result });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({
          status: "error",
          message:
            cause instanceof Error
              ? cause.message
              : "Source could not be loaded.",
        });
      });

    return () => controller.abort();
  }, [repositoryId, snapshotId, path, attempt]);

  const highlighted = useMemo(
    () => (load.status === "ready" ? highlightSource(load.text, path) : null),
    [load, path],
  );

  const lineCount = highlighted?.lines.length ?? 0;

  // Scroll to the requested line once content is available.
  useEffect(() => {
    if (!highlighted || !line || !scroller.current) return;
    const target = scrollTopForIndex(line - 1, lineCount, height, ROW_HEIGHT);
    scroller.current.scrollTop = target;
    setScrollTop(target);
  }, [highlighted, line, lineCount, height]);

  if (load.status === "loading") return <Spinner label="Loading source..." />;

  if (load.status === "error") {
    return (
      <ErrorBox
        message={load.message}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }

  if (!highlighted) return null;

  const hashMismatch =
    analysisContentHash !== null &&
    load.etag !== null &&
    load.etag.replace(/"/g, "") !== analysisContentHash;

  const win = visibleWindow(lineCount, scrollTop, height, ROW_HEIGHT, 12);
  const gutter = String(lineCount).length;
  const emphasised = (n: number) =>
    range ? n >= range.startLine && n <= range.endLine : false;

  const goToLine = () => {
    const n = Number.parseInt(jump, 10);
    if (!Number.isInteger(n) || n < 1 || !scroller.current) return;
    const target = scrollTopForIndex(
      Math.min(n, lineCount) - 1,
      lineCount,
      height,
      ROW_HEIGHT,
    );
    scroller.current.scrollTop = target;
    setScrollTop(target);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-stone-800 px-4 py-2">
        <span
          className="truncate font-mono text-xs text-stone-300"
          title={path}
        >
          {path}
        </span>
        <Badge>{lineCount.toLocaleString()} lines</Badge>
        <Badge>{formatBytes(load.bytes)}</Badge>
        {highlighted.highlightSkipped && (
          <Badge
            tone="warn"
            title="Highlighting is skipped for very large files."
          >
            plain text
          </Badge>
        )}
        {hashMismatch && (
          <Badge
            tone="warn"
            title="The source served now differs from the content that was analysed."
          >
            differs from analysed content
          </Badge>
        )}
        <form
          className="ml-auto flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            goToLine();
          }}
        >
          <label htmlFor="goto-line" className="sr-only">
            Go to line
          </label>
          <input
            id="goto-line"
            inputMode="numeric"
            value={jump}
            onChange={(event) => setJump(event.target.value.replace(/\D/g, ""))}
            placeholder="Line"
            className={`${inputClass} !w-20 !py-1`}
          />
        </form>
      </div>

      {lineCount === 1 && highlighted.lines[0].length === 0 ? (
        <p className="p-6 text-sm text-stone-500">This file is empty.</p>
      ) : (
        <div
          ref={scroller}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          style={{ height }}
          className="overflow-auto bg-stone-950 font-mono text-[13px]"
          tabIndex={0}
          aria-label={`Source of ${path}`}
        >
          <div
            style={{
              height: win.totalHeight,
              position: "relative",
              minWidth: "max-content",
            }}
          >
            <div style={{ transform: `translateY(${win.offsetTop}px)` }}>
              {highlighted.lines.slice(win.start, win.end).map((tokens, i) => {
                const number = win.start + i + 1;
                const hit = emphasised(number) || number === line;

                return (
                  <div
                    key={number}
                    id={`L${number}`}
                    style={{
                      height: ROW_HEIGHT,
                      lineHeight: `${ROW_HEIGHT}px`,
                    }}
                    className={`flex whitespace-pre ${
                      hit ? "bg-orange-500/10" : ""
                    }`}
                  >
                    <span
                      className="sticky left-0 select-none bg-stone-950 pr-4 pl-3 text-right text-stone-600"
                      style={{ minWidth: `${gutter + 3}ch` }}
                      aria-hidden="true"
                    >
                      {number}
                    </span>
                    <code className="pr-6">
                      {tokens.map((token, index) => (
                        <span key={index} className={tokenClass[token.kind]}>
                          {token.text}
                        </span>
                      ))}
                    </code>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
