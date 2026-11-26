import { cn } from "@/lib/cn";
import { progressLabel, type SuiteProgress } from "../lib/progress";

/** Read-only outcome; intentionally a circle, distinct from square membership checkboxes. */
export function SuiteProgressMark({ progress, running, index }: { progress: SuiteProgress; running: boolean; index: number }) {
  const attention = progress.attention > 0 ? `${progress.attention} need attention` : null;
  const label = running ? `Running${attention === null ? "" : ` · ${attention}`}` : attention ?? (progress.complete ? "Complete" : progressLabel(progress));
  return <span role="img" aria-label={label} title={`${label} · ${progressLabel(progress)}`} className={cn(
    "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs numeric",
    running ? "animate-breathe border-info/50 bg-info/10 text-info" : progress.attention > 0 ? "border-warning/40 bg-warning/10 text-warning" : progress.complete ? "border-success/40 bg-success/10 text-success" : "border-line text-fg-dim",
  )}>{running ? "▶" : progress.attention > 0 ? "!" : progress.complete ? "✓" : index + 1}</span>;
}
