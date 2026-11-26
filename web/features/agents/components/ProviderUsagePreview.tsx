"use client";

import type { ProviderUsage } from "@hydra/shared";
import { usageState } from "../lib/configuration";
import { windowLabel } from "./usage";
import styles from "./configuration.module.css";

export function ProviderUsagePreview({
  label,
  usage,
  loading,
  error,
  checkedAt,
  onOpen,
}: {
  label: string;
  usage: ProviderUsage | null;
  loading: boolean;
  error: string | null;
  checkedAt: number;
  onOpen(): void;
}) {
  const state = usageState(usage, loading, error, checkedAt);
  const windows = usage?.available ? usage.windows : [];
  const status = windows.length === 0 || loading || state.tone === "warning";
  const summary = windows
    .map(
      (window) =>
        `${windowLabel(window)} ${window.usedPercent === null ? "not reported" : `${Math.round(window.usedPercent)}% used`}`,
    )
    .join(", ");
  return (
    <button
      type="button"
      className={styles.usagePreview}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Open ${label} Usage & maintenance: ${state.label}${summary ? `; ${summary}` : ""}`}
      aria-busy={loading}
      data-warning={state.tone === "warning"}
      data-stale={
        state.tone === "warning" && state.label.startsWith("Usage stale")
      }
    >
      {status && (
        <span className={styles.usagePreviewStatus}>{state.label} ›</span>
      )}
      {windows.length === 0 && (
        <span className={styles.usagePreviewTrack} aria-hidden="true" />
      )}
      {windows.map((window, index) => {
        const percent = window.usedPercent;
        return (
          <span
            key={`${window.kind}-${index}`}
            className={styles.usagePreviewWindow}
          >
            <span>{windowLabel(window)}</span>
            <span
              className={styles.usagePreviewTrack}
              role={percent === null ? undefined : "progressbar"}
              aria-label={`${label} ${windowLabel(window)} usage`}
              aria-valuemin={percent === null ? undefined : 0}
              aria-valuemax={percent === null ? undefined : 100}
              aria-valuenow={
                percent === null
                  ? undefined
                  : Math.max(0, Math.min(100, percent))
              }
              aria-valuetext={
                percent === null ? undefined : `${Math.round(percent)}% used`
              }
              data-tone={
                percent === null
                  ? "unknown"
                  : percent >= 90
                    ? "danger"
                    : percent >= 70
                      ? "warning"
                      : "success"
              }
            >
              <span
                style={{
                  width: `${percent === null ? 0 : Math.max(0, Math.min(100, percent))}%`,
                }}
              />
            </span>
            <span className={styles.usagePreviewPercent}>
              {percent === null ? "—" : `${Math.round(percent)}%`}
            </span>
          </span>
        );
      })}
    </button>
  );
}
