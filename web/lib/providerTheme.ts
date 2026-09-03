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
  /** Solid fill, for dots and avatar cores. */
  fill: string;
  /**
   * The raw CSS variable. SVG `fill`/`stroke` and `color-mix()` need a real
   * colour value rather than a utility class — the avatars in a later phase are
   * drawn with this.
   */
  cssVar: string;
}

/**
 * One hue per agent, drawn from theme tokens rather than the fixed Tailwind
 * palette so an agent keeps its identity in every theme. A hardcoded
 * `amber-300` reads well on a near-black surface and is unreadable on white;
 * `agent-claude` is defined per theme and stays legible in all three.
 */
export const providerTheme: Record<ProviderId, ProviderTheme> = {
  claude: {
    text: "text-agent-claude",
    chip: "bg-agent-claude/10 text-agent-claude ring-agent-claude/30",
    rule: "border-agent-claude/40",
    active: "bg-agent-claude/15 text-agent-claude ring-agent-claude/40",
    fill: "bg-agent-claude",
    cssVar: "var(--agent-claude)",
  },
  codex: {
    text: "text-agent-codex",
    chip: "bg-agent-codex/10 text-agent-codex ring-agent-codex/30",
    rule: "border-agent-codex/40",
    active: "bg-agent-codex/15 text-agent-codex ring-agent-codex/40",
    fill: "bg-agent-codex",
    cssVar: "var(--agent-codex)",
  },
  cursor: {
    text: "text-agent-cursor",
    chip: "bg-agent-cursor/10 text-agent-cursor ring-agent-cursor/30",
    rule: "border-agent-cursor/40",
    active: "bg-agent-cursor/15 text-agent-cursor ring-agent-cursor/40",
    fill: "bg-agent-cursor",
    cssVar: "var(--agent-cursor)",
  },
  grok: {
    text: "text-agent-grok",
    chip: "bg-agent-grok/10 text-agent-grok ring-agent-grok/30",
    rule: "border-agent-grok/40",
    active: "bg-agent-grok/15 text-agent-grok ring-agent-grok/40",
    fill: "bg-agent-grok",
    cssVar: "var(--agent-grok)",
  },
  copilot: {
    text: "text-agent-copilot",
    chip: "bg-agent-copilot/10 text-agent-copilot ring-agent-copilot/30",
    rule: "border-agent-copilot/40",
    active: "bg-agent-copilot/15 text-agent-copilot ring-agent-copilot/40",
    fill: "bg-agent-copilot",
    cssVar: "var(--agent-copilot)",
  },
};
