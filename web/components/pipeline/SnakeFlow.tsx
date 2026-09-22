"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

/** Minimum card track width — below this we drop a column rather than crush cards. */
const MIN_CARD_PX = 200;
const GUTTER_PX = 40; // room for a horizontal connector between cards
/** Soft ceiling so ultrawide monitors don't pack an unreadably dense row. */
const MAX_COLS = 8;

function columnsForWidth(width: number, itemCount: number): number {
  if (width < 640 || itemCount <= 1) return 1;
  const fit = Math.max(1, Math.floor((width + GUTTER_PX) / (MIN_CARD_PX + GUTTER_PX)));
  // Prefer fewer columns when there aren't enough cards to fill a wider row, so
  // the cards stretch across the available width instead of leaving empty tracks.
  return Math.min(MAX_COLS, fit, itemCount);
}

type Row<T> = {
  items: Array<{ item: T; index: number }>;
  /** Odd rows read left→right; even rows read right→left (snake). */
  rtl: boolean;
  /** Grid column (0-based) where this row's trailing edge sits — used to park the turn box. */
  turnColumn: number;
};

function chunkSnake<T>(items: T[], cols: number): Row<T>[] {
  if (items.length === 0 || cols < 1) return [];
  const rows: Row<T>[] = [];
  for (let start = 0; start < items.length; start += cols) {
    const slice = items.slice(start, start + cols).map((item, offset) => ({
      item,
      index: start + offset,
    }));
    const rtl = rows.length % 2 === 1;
    // LTR rows end on the rightmost occupied column; RTL rows end on the leftmost.
    const turnColumn = rtl ? 0 : slice.length - 1;
    rows.push({ items: slice, rtl, turnColumn });
  }
  return rows;
}

/**
 * Snake / zigzag flow: cards stretch to fill the available width, wrap by
 * how many min-width tracks fit, and turn with a down-arrow into a junction
 * box under the last card of a row. Even rows run right→left.
 */
export function SnakeFlow<T>({
  items,
  getKey,
  renderCard,
  isLiveIndex,
  wrapItem,
}: {
  items: T[];
  getKey(item: T, index: number): string | number;
  renderCard(item: T, index: number): ReactNode;
  /** When set, connectors leaving this card index animate as live energy. */
  isLiveIndex?(index: number): boolean;
  /** Optional wrapper around each card cell (e.g. drag handlers). */
  wrapItem?(node: ReactNode, item: T, index: number): ReactNode;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(1);

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setCols(columnsForWidth(el.clientWidth, items.length));
  }, [items.length]);

  useEffect(() => {
    measure();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const rows = useMemo(() => chunkSnake(items, cols), [items, cols]);

  if (items.length === 0) return null;

  return (
    <div ref={scrollerRef} className="w-full min-w-0">
      <div
        role="list"
        style={{ display: "flex", flexDirection: "column", gap: 0 }}
      >
        {rows.map((row, rowIndex) => {
          const hasTurn = rowIndex < rows.length - 1;
          const nextRow = hasTurn ? rows[rowIndex + 1] : null;
          // Live if the last card of this row (in reading order) is the live station.
          const lastInRow = row.items[row.items.length - 1];
          const turnLive = lastInRow !== undefined && (isLiveIndex?.(lastInRow.index) ?? false);

          return (
            <div key={`row-${rowIndex}`} role="listitem">
              <SnakeRow
                row={row}
                cols={cols}
                getKey={getKey}
                renderCard={renderCard}
                wrapItem={wrapItem}
                isLiveIndex={isLiveIndex}
              />
              {hasTurn && nextRow !== undefined && nextRow !== null && (
                <TurnJunction
                  cols={cols}
                  fromColumn={row.turnColumn}
                  // RTL rows are right-aligned, so the next card sits under the
                  // rightmost column (same as an LTR turn). LTR rows start at 0.
                  toColumn={nextRow.rtl ? cols - 1 : 0}
                  live={turnLive}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SnakeRow<T>({
  row,
  cols,
  getKey,
  renderCard,
  wrapItem,
  isLiveIndex,
}: {
  row: Row<T>;
  cols: number;
  getKey(item: T, index: number): string | number;
  renderCard(item: T, index: number): ReactNode;
  wrapItem?(node: ReactNode, item: T, index: number): ReactNode;
  isLiveIndex?(index: number): boolean;
}) {
  // Visual order: LTR as-is; RTL reversed so the next item after a turn sits
  // under/near the junction and subsequent items grow to the left.
  const visual = row.rtl ? [...row.items].reverse() : row.items;

  // Right-align partial RTL rows so the first logical item of the row sits
  // under the previous turn column (right edge), with later items to its left.
  const startCol = row.rtl ? Math.max(0, cols - visual.length) : 0;

  return (
    <div
      className="w-full items-stretch gap-y-0"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        columnGap: GUTTER_PX,
        // Placement is explicit via gridColumn / startCol — do not justify the
        // track list, or RTL rows drift off the turn column.
      }}
    >
      {visual.map((entry, visualIndex) => {
        const gridColumn = startCol + visualIndex + 1;
        const showConnectorAfter = visualIndex < visual.length - 1;
        // Connector is "live" when it leaves the live card toward the next.
        const fromIndex = entry.index;
        const live = isLiveIndex?.(fromIndex) ?? false;
        // In RTL visual order, the connector after a cell points left (toward
        // higher visualIndex? No — we draw between cells in visual order, and
        // the arrow direction follows reading order: RTL uses ←).
        const direction = row.rtl ? "left" : "right";

        const card = (
          <div className="relative h-full min-w-0 w-full">
            {renderCard(entry.item, entry.index)}
            {showConnectorAfter && cols > 1 && (
              <HorizontalLink direction={direction} live={live} />
            )}
          </div>
        );

        return (
          <div
            key={getKey(entry.item, entry.index)}
            className="relative min-w-0 w-full"
            style={{ gridColumn }}
          >
            {wrapItem ? wrapItem(card, entry.item, entry.index) : card}
          </div>
        );
      })}
    </div>
  );
}

function HorizontalLink({
  direction,
  live,
}: {
  direction: "left" | "right";
  live: boolean;
}) {
  // Parked in the gutter to the right of the card. For RTL rows the arrow
  // still lives in that gutter but points left toward the next visual card.
  return (
    <div
      className="pointer-events-none absolute top-1/2 -right-10 flex h-8 w-10 -translate-y-1/2 items-center justify-center"
      aria-hidden
    >
      <svg viewBox="0 0 40 8" className="h-3 w-10 text-accent" fill="none">
        <path
          d={direction === "right" ? "M1 4h32" : "M39 4H7"}
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          className={cn(live ? "pipeline-energy opacity-90" : "opacity-35")}
        />
        {direction === "right" ? (
          <path
            d="M33 1.5 38 4l-5 2.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={live ? "opacity-90" : "opacity-40"}
          />
        ) : (
          <path
            d="M7 1.5 2 4l5 2.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={live ? "opacity-90" : "opacity-40"}
          />
        )}
      </svg>
    </div>
  );
}

function TurnJunction({
  cols,
  fromColumn,
  toColumn,
  live,
}: {
  cols: number;
  fromColumn: number;
  toColumn: number;
  live: boolean;
}) {
  // Single-column (mobile): a simple vertical step, no side box offset needed.
  if (cols === 1) {
    return (
      <div className="flex w-full flex-col items-center py-2" aria-hidden>
        <VerticalStem live={live} />
        <JunctionBox live={live} />
        <VerticalStem live={live} tip />
      </div>
    );
  }

  return (
    <div
      className="w-full"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        columnGap: GUTTER_PX,
      }}
      aria-hidden
    >
      <div
        className="flex flex-col items-center py-2"
        style={{ gridColumn: fromColumn + 1 }}
      >
        <VerticalStem live={live} />
        <JunctionBox live={live} />
        {/* Same-column turns (LTR→RTL under the right edge) continue straight
            down; otherwise a short elbow hints toward the next row's start. */}
        {toColumn !== fromColumn ? (
          <ElbowHint fromColumn={fromColumn} toColumn={toColumn} live={live} />
        ) : (
          <VerticalStem live={live} tip />
        )}
      </div>
    </div>
  );
}

function VerticalStem({ live, tip = false }: { live: boolean; tip?: boolean }) {
  return (
    <svg viewBox="0 0 8 28" className="h-7 w-2 text-accent" fill="none">
      <path
        d="M4 1v20"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        className={cn(live ? "pipeline-energy opacity-90" : "opacity-35")}
      />
      {tip && (
        <path
          d="M1.5 18 4 23.5 6.5 18"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={live ? "opacity-90" : "opacity-40"}
        />
      )}
    </svg>
  );
}

function JunctionBox({ live }: { live: boolean }) {
  return (
    <div
      className={cn(
        "glass flex size-7 items-center justify-center rounded-md shadow-md",
        live && "ring-1 ring-accent/40 text-accent",
        !live && "text-fg-dim",
      )}
      title="Continues below"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          d="M6 2.5v7M3.5 7.5 6 10l2.5-2.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function ElbowHint({
  fromColumn,
  toColumn,
  live,
}: {
  fromColumn: number;
  toColumn: number;
  live: boolean;
}) {
  const leftward = toColumn < fromColumn;
  return (
    <div className="relative mt-1 flex h-6 w-full items-center justify-center">
      <svg
        viewBox="0 0 48 24"
        className={cn("h-6 w-12 text-accent", leftward ? "" : "scale-x-[-1]")}
        fill="none"
      >
        <path
          d="M24 2v8H6"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(live ? "pipeline-energy opacity-90" : "opacity-35")}
        />
        <path
          d="M9 7.5 3.5 10 9 12.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={live ? "opacity-90" : "opacity-40"}
        />
      </svg>
    </div>
  );
}
