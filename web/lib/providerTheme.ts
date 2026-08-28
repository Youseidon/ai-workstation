import type { ProviderId } from "@agent-console/shared";

export interface ProviderTheme {
  /** Tag text colour. */
  text: string;
  /** Tag background. */
  chip: string;
  /** Left rule on log entries. */
  rule: string;
  /** Selected state in the switcher. */
  active: string;
}

export const providerTheme: Record<ProviderId, ProviderTheme> = {
  claude: {
    text: "text-amber-300",
    chip: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
    rule: "border-amber-500/40",
    active: "bg-amber-500/15 text-amber-200 ring-amber-400/40",
  },
  codex: {
    text: "text-emerald-300",
    chip: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
    rule: "border-emerald-500/40",
    active: "bg-emerald-500/15 text-emerald-200 ring-emerald-400/40",
  },
  cursor: {
    text: "text-sky-300",
    chip: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
    rule: "border-sky-500/40",
    active: "bg-sky-500/15 text-sky-200 ring-sky-400/40",
  },
  grok: {
    text: "text-rose-300",
    chip: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
    rule: "border-rose-500/40",
    active: "bg-rose-500/15 text-rose-200 ring-rose-400/40",
  },
};
