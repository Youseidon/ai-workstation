"use client";

import type { ReactNode } from "react";
import type { OperationsPrompt, PromptPipelineRule, SuitePipelineRun } from "@agent-console/shared";
import { modelLabel } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { onBlockedChip } from "./status";

export function RecoverySiding({
  item,
  rule,
  pipeline,
  children,
}: {
  item: OperationsPrompt;
  rule: PromptPipelineRule;
  pipeline: SuitePipelineRun | null | undefined;
  children?: ReactNode;
}) {
  const blocked =
    item.operationalState === "AWAITING_RESPONSE" ||
    item.operationalState === "RECOVERY_NEEDED" ||
    item.operationalState === "FAILED";
  const recovering = pipeline?.recovering === true && pipeline.currentPromptId === item.prompt.id;
  const exhausted = pipeline?.stopReason === "recover_exhausted" && pipeline.currentPromptId === item.prompt.id;
  const retrying = rule.onBlocked === "retry" && pipeline?.currentPromptId === item.prompt.id && (pipeline.state === "PLAYING" || blocked);
  const open = rule.onBlocked !== "wait" || blocked || recovering || exhausted;
  const hue =
    rule.onBlocked === "recover" && rule.recoverProvider !== null
      ? providerTheme[rule.recoverProvider].cssVar
      : "var(--warning)";

  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className="mt-1.5 animate-slide-up rounded-md px-2.5 py-1.5 ring-1 ring-inset ring-line"
          style={{ background: `color-mix(in oklab, ${hue}, 12%, transparent)` }}
        >
          <div className="text-[10px] uppercase tracking-wider text-fg-dim">recovery siding</div>
          <div className="mt-0.5 text-[11px] text-fg-muted">{copy({ rule, pipeline, recovering, exhausted, retrying })}</div>
          {children !== undefined && children !== null && <div className="mt-1.5">{children}</div>}
        </div>
      </div>
    </div>
  );
}

function copy({
  rule,
  pipeline,
  recovering,
  exhausted,
  retrying,
}: {
  rule: PromptPipelineRule;
  pipeline: SuitePipelineRun | null | undefined;
  recovering: boolean;
  exhausted: boolean;
  retrying: boolean;
}): string {
  if (exhausted) return "Recovered, still blocked — pipeline stopped.";
  if (recovering) {
    const model = rule.recoverProvider === null ? null : modelLabel(rule.recoverProvider, rule.recoverModel);
    return `Recovering with ${rule.recoverProvider ?? "override"}${model === null ? "" : ` · ${model}`}`;
  }
  if (pipeline != null && (retrying || (rule.onBlocked === "retry" && pipeline.attempt > 0))) {
    const n = Math.max(pipeline.attempt, 1);
    return `Retry ${n}/${rule.retryLimit} with ${pipeline.playProvider ?? "the play provider"}…`;
  }
  if (rule.onBlocked === "wait") return "Waiting for you — answer in the detail pane.";
  if (rule.onBlocked === "skip") return "Skipped — moving to next ready station.";
  if (rule.onBlocked === "recover") return onBlockedChip(rule);
  return onBlockedChip(rule);
}
