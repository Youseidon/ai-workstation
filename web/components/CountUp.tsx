"use client";

import { useEffect, useRef, useState } from "react";

export function countUpDisplayValue(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Animates a number to its new value instead of snapping.
 *
 * Purely presentational: the displayed value always lands exactly on `value`,
 * and under reduced motion the global animation rules make the transition
 * imperceptible rather than wrong.
 */
export function CountUp({
  value,
  format,
  durationMs = 450,
}: {
  value: number;
  format?: (value: number) => string;
  durationMs?: number;
}) {
  const [shown, setShown] = useState(countUpDisplayValue(value));
  const fromRef = useRef(value);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min((now - start) / durationMs, 1);
      // Ease out, so the number settles rather than stopping dead.
      const eased = 1 - (1 - progress) ** 3;
      setShown(countUpDisplayValue(Math.round(from + (value - from) * eased)));
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      fromRef.current = value;
    };
  }, [value, durationMs]);

  const display = countUpDisplayValue(shown);
  return <>{format === undefined ? display.toLocaleString() : format(display)}</>;
}
