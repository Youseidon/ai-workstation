"use client";

import { useCallback, useRef, useState } from "react";
import type { PromptPipelineRule, ProviderId, ProviderInfo } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import type { ModelSelection } from "@/lib/useModelSelection";
import { RulePopover, type RuleKind, type RulePatch } from "./RulePopover";
import { onBlockedChip, onDoneChip, overrideChip } from "./status";

export function StationRules({
  rule,
  disabled,
  providers,
  models,
  fallbackProvider,
  onChange,
}: {
  rule: PromptPipelineRule;
  disabled: boolean;
  providers: ProviderInfo[];
  models: ModelSelection;
  fallbackProvider: ProviderId;
  onChange(patch: RulePatch): void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      <RuleChip
        kind="done"
        rule={rule}
        disabled={disabled}
        providers={providers}
        models={models}
        fallbackProvider={fallbackProvider}
        onChange={onChange}
      />
      <RuleChip
        kind="blocked"
        rule={rule}
        disabled={disabled}
        providers={providers}
        models={models}
        fallbackProvider={fallbackProvider}
        onChange={onChange}
      />
      <RuleChip
        kind="provider"
        rule={rule}
        disabled={disabled}
        providers={providers}
        models={models}
        fallbackProvider={fallbackProvider}
        onChange={onChange}
      />
    </div>
  );
}

export function RuleChip({
  kind,
  rule,
  disabled,
  providers,
  models,
  fallbackProvider,
  onChange,
}: {
  kind: RuleKind;
  rule: PromptPipelineRule;
  disabled: boolean;
  providers: ProviderInfo[];
  models: ModelSelection;
  fallbackProvider: ProviderId;
  onChange(patch: RulePatch): void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const label =
    kind === "done" ? onDoneChip(rule.onDone) : kind === "blocked" ? onBlockedChip(rule) : overrideChip(rule) ?? "inherit";
  const isOverride = kind === "provider" && rule.provider !== null;
  const theme = rule.provider !== null && kind === "provider" ? providerTheme[rule.provider] : null;
  const recoverTheme =
    kind === "blocked" && rule.onBlocked === "recover" && rule.recoverProvider !== null
      ? providerTheme[rule.recoverProvider]
      : null;

  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        title={disabled ? "Rules lock while this station is running" : `Edit ${kind} rule`}
        onClick={(event) => {
          event.stopPropagation();
          if (disabled) return;
          setOpen((current) => !current);
        }}
        className={cn(
          "rounded-full px-1.5 py-px text-[10px] uppercase tracking-wider ring-1 ring-inset transition-colors",
          disabled && "cursor-not-allowed opacity-40",
          isOverride && theme !== null
            ? theme.chip
            : recoverTheme !== null
              ? recoverTheme.chip
              : "text-fg-dim ring-line hover:bg-surface-3 hover:text-fg-muted",
          kind === "provider" && rule.provider === null && "normal-case tracking-normal",
        )}
      >
        {label}
      </button>
      {open && ref.current !== null && (
        <RulePopover
          kind={kind}
          rule={rule}
          providers={providers}
          models={models}
          fallbackProvider={fallbackProvider}
          anchor={ref.current.getBoundingClientRect()}
          onChange={(patch) => {
            onChange(patch);
          }}
          onClose={close}
        />
      )}
    </>
  );
}
