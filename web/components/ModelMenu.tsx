"use client";

import { useEffect, useRef, useState } from "react";
import type { ProviderId } from "@agent-console/shared";
import { MODEL_CATALOG, isCustomModel } from "@agent-console/shared";
import { providerTheme } from "@/lib/providerTheme";

interface Props {
  provider: ProviderId;
  /** Currently selected model id; `null` is the provider's own default. */
  selected: string | null;
  /** The model configured in settings, shown as the inherited value. */
  configured: string | null;
  /** False when the selection is inherited from settings rather than pinned. */
  pinned: boolean;
  onSelect(model: string | null): void;
  /** Drop the pin so this provider tracks its settings value again. */
  onClear(): void;
  onClose(): void;
}

/**
 * The dropdown behind a provider pill's model half. Catalog entries first, then
 * a free-text row so a model newer than the catalog is still reachable.
 */
export function ModelMenu({
  provider,
  selected,
  configured,
  pinned,
  onSelect,
  onClear,
  onClose,
}: Props) {
  const [custom, setCustom] = useState(isCustomModel(provider, selected) ? (selected ?? "") : "");
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = providerTheme[provider];
  const options = MODEL_CATALOG[provider];

  // Click-away and Escape both close, so the menu never strands the header.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const submitCustom = () => {
    const value = custom.trim();
    if (value === "") return;
    onSelect(value);
  };

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={`${provider} model`}
      className="absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-md border border-[#252c35] bg-[#0e1115] shadow-xl shadow-black/50"
    >
      <div className="border-b border-[#1d2229] px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-[#4e5661]">
        {provider} model
      </div>

      <div className="max-h-72 overflow-y-auto py-1">
        {options.map((option) => {
          const isSelected = option.id === selected;
          const isConfigured = option.id === configured;
          return (
            <button
              key={option.id ?? "__default__"}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(option.id)}
              className={[
                "flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs transition-colors",
                isSelected ? theme.chip : "text-[#c3cbd6] hover:bg-[#161b21]",
              ].join(" ")}
            >
              <span className={isSelected ? "" : "text-[#4e5661]"}>{isSelected ? "●" : "○"}</span>
              <span className="shrink-0">{option.label}</span>
              <span className="ml-auto truncate pl-2 text-right text-[10px] text-[#5b636e]">
                {isConfigured && !isSelected ? "from settings" : option.hint}
              </span>
            </button>
          );
        })}

        {isCustomModel(provider, selected) && (
          <div className={`mx-2 my-1 rounded px-1.5 py-1 text-[10px] ${theme.chip}`}>
            custom · {selected}
          </div>
        )}
      </div>

      <div className="border-t border-[#1d2229] p-2">
        <div className="flex gap-1.5">
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submitCustom();
            }}
            placeholder="custom model id…"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-[#1d2229] bg-[#101317] px-2 py-1 text-[11px] text-[#e7ecf2] placeholder:text-[#4e5661] focus:border-[#2f3742] focus:outline-none"
          />
          <button
            type="button"
            onClick={submitCustom}
            disabled={custom.trim() === ""}
            className="shrink-0 rounded border border-[#2a323c] bg-[#181d24] px-2 text-[11px] text-[#c3cbd6] transition-colors hover:bg-[#20262e] disabled:opacity-40"
          >
            use
          </button>
        </div>
        {pinned && (
          <button
            type="button"
            onClick={onClear}
            className="mt-1.5 w-full rounded px-2 py-1 text-left text-[10px] text-[#5b636e] transition-colors hover:text-[#9aa4b1]"
          >
            ↺ follow settings{configured === null ? "" : ` (${configured})`}
          </button>
        )}
      </div>
    </div>
  );
}
