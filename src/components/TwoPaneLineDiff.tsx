import { useRef } from "react";
import * as Diff from "diff";

export interface TwoPaneLineDiffProps {
  leftLabel: string;
  rightLabel: string;
  left: string;
  right: string;
}

/**
 * GitHub-style side-by-side line diff: equal-height rows, removed lines only
 * on the left (red), added only on the right (green), unchanged on both.
 */
export function TwoPaneLineDiff({
  leftLabel,
  rightLabel,
  left,
  right,
}: TwoPaneLineDiffProps) {
  const rows = buildSideBySideRows(left, right);
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  /** Which pane initiated a programmatic scroll sync (suppress the peer's scroll event). */
  const syncing = useRef<"left" | "right" | null>(null);

  const syncScroll = (from: "left" | "right", scrollTop: number) => {
    const other = from === "left" ? rightScrollRef.current : leftScrollRef.current;
    if (!other) return;
    syncing.current = from;
    other.scrollTop = scrollTop;
    requestAnimationFrame(() => {
      syncing.current = null;
    });
  };

  return (
    <div className="flex max-h-[min(70vh,560px)] flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      <div className="grid shrink-0 grid-cols-2 border-b border-zinc-800 bg-zinc-900/80 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        <div className="border-r border-zinc-800 px-2 py-1">{leftLabel}</div>
        <div className="px-2 py-1">{rightLabel}</div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 overflow-hidden">
        <div
          ref={leftScrollRef}
          onScroll={() => {
            if (syncing.current === "right") return;
            const el = leftScrollRef.current;
            if (el) syncScroll("left", el.scrollTop);
          }}
          className="overflow-auto border-r border-zinc-800 font-mono text-xs leading-snug"
        >
          {rows.map((r, i) => (
            <div
              key={`l-${i}`}
              className={`border-b border-zinc-900/50 px-2 py-0.5 whitespace-pre-wrap break-all ${
                r.leftKind === "removed"
                  ? "bg-red-950/50 text-red-100"
                  : r.leftKind === "empty"
                    ? "bg-zinc-950 text-transparent select-none"
                    : "text-zinc-300"
              }`}
            >
              {r.left || " "}
            </div>
          ))}
        </div>
        <div
          ref={rightScrollRef}
          onScroll={() => {
            if (syncing.current === "left") return;
            const el = rightScrollRef.current;
            if (el) syncScroll("right", el.scrollTop);
          }}
          className="overflow-auto font-mono text-xs leading-snug"
        >
          {rows.map((r, i) => (
            <div
              key={`r-${i}`}
              className={`border-b border-zinc-900/50 px-2 py-0.5 whitespace-pre-wrap break-all ${
                r.rightKind === "added"
                  ? "bg-emerald-950/50 text-emerald-100"
                  : r.rightKind === "empty"
                    ? "bg-zinc-950 text-transparent select-none"
                    : "text-zinc-300"
              }`}
            >
              {r.right || " "}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type RowKind = "neutral" | "removed" | "added" | "empty";

interface SideRow {
  left: string;
  right: string;
  leftKind: RowKind;
  rightKind: RowKind;
}

function buildSideBySideRows(left: string, right: string): SideRow[] {
  const parts = Diff.diffLines(left, right, { newlineIsToken: true });
  const rows: SideRow[] = [];

  for (const part of parts) {
    const token = part.value;
    if (token === "") continue;

    if (part.added) {
      for (const line of splitNewlineTokens(token)) {
        rows.push({
          left: "",
          right: line,
          leftKind: "empty",
          rightKind: "added",
        });
      }
      continue;
    }
    if (part.removed) {
      for (const line of splitNewlineTokens(token)) {
        rows.push({
          left: line,
          right: "",
          rightKind: "empty",
          leftKind: "removed",
        });
      }
      continue;
    }
    for (const line of splitNewlineTokens(token)) {
      rows.push({
        left: line,
        right: line,
        leftKind: "neutral",
        rightKind: "neutral",
      });
    }
  }

  return rows;
}

/** With newlineIsToken, each piece is typically one logical line including its trailing `\n` (except possibly the last chunk of a file). */
function splitNewlineTokens(value: string): string[] {
  if (value === "") return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\n") {
      out.push(value.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < value.length) {
    out.push(value.slice(start));
  }
  return out;
}
