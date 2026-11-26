"use client";

import type { ReactNode } from "react";
import styles from "./workspace.module.css";

/** Row-major execution order keeps reading, keyboard and DOM order identical at every width. */
export function SnakeFlow<T>({ items, getKey, renderCard, isLiveIndex, wrapItem, renderGate }: {
  items: T[];
  getKey(item: T, index: number): string | number;
  renderCard(item: T, index: number): ReactNode;
  isLiveIndex?(index: number): boolean;
  wrapItem?(node: ReactNode, item: T, index: number): ReactNode;
  renderGate?(item: T, index: number): ReactNode;
}) {
  if (items.length === 0) return null;
  return <ol aria-label="Steps in execution order" className={styles.steps}>
    {items.map((item, index) => {
      const card = <div className={styles.stepCard}>{renderCard(item, index)}</div>;
      return <li key={getKey(item, index)} className={styles.step} data-running={isLiveIndex?.(index) || undefined}>
        {wrapItem ? <div className={styles.stepCard}>{wrapItem(card, item, index)}</div> : card}
        {renderGate?.(item, index)}
      </li>;
    })}
  </ol>;
}
