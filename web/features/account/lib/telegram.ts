import type { TelegramAccess, TelegramBotView } from "@hydra/shared";

export const ACCESS_OPTIONS: Array<{ value: TelegramAccess; label: string; description: string }> = [
  {
    value: "notify",
    label: "Notifications only",
    description: "Alerts when an agent needs an answer, a run fails or a pipeline finishes, plus read-only /status, /pipelines and /gates.",
  },
  {
    value: "control",
    label: "Full control",
    description: "Also play, pause and stop pipelines, stop agents and answer questions from Telegram. Every action asks you to confirm in the chat.",
  },
];

export function botStatusLabel(bot: TelegramBotView): string {
  switch (bot.status) {
    case "polling": return "Connected";
    case "connecting": return "Connecting…";
    case "stopped": return "Stopped";
    case "error": return bot.error ?? "Not working";
  }
}

const AUDIT_LABELS: Record<string, string> = {
  linked: "Connected",
  unlinked: "Disconnected",
  access_changed: "Access changed",
  reset_requested: "Reset code sent",
  password_reset: "Password reset",
  stop_run: "Stopped an agent",
  play: "Played a pipeline",
  pause: "Paused a pipeline",
  stop_pipeline: "Stopped a pipeline",
  answer: "Answered a question",
};

export function auditLabel(action: string): string {
  if (action.endsWith("_failed")) return `${AUDIT_LABELS[action.slice(0, -"_failed".length)] ?? action} (failed)`;
  return AUDIT_LABELS[action] ?? action;
}

export function minutesLeft(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
}
