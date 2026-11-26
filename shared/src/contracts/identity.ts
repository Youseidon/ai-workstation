export interface UserIdentity {
  id: string;
  username: string;
  ownsLegacyData: boolean;
  /** A throwaway account made from "Try the demo"; it is deleted when it expires. */
  demo?: boolean;
  /** When a demo account and its sample folder are removed. */
  demoExpiresAt?: string;
}

export interface IdentitySession {
  user: UserIdentity | null;
}

export type TelegramAccess = "notify" | "control";

export interface TelegramLinkView {
  telegramUsername: string | null;
  access: TelegramAccess;
  linkedAt: string;
}

export interface TelegramBotView {
  username: string;
  status: "connecting" | "polling" | "error" | "stopped";
  error: string | null;
}

export interface TelegramAccountView {
  isOwner: boolean;
  bot: TelegramBotView | null;
  link: TelegramLinkView | null;
}

export interface TelegramLinkCode {
  url: string;
  code: string;
  expiresAt: string;
}

export interface TelegramAuditEntry {
  at: string;
  action: string;
  detail: string;
}

/** The stages of preparing a demo account, in the order they happen. */
export type DemoSeedStep = "account" | "runtime" | "folder" | "git" | "workspace" | "library" | "pipelines" | "chats" | "stations" | "settings" | "ready";

/** One line of the NDJSON stream `POST /api/auth/demo` answers with. */
export interface DemoSeedProgress {
  step: DemoSeedStep;
  state: "active" | "done" | "error";
  detail: string;
}

export interface DemoAvailability {
  available: boolean;
  /** How long a demo account lives before it is deleted, in hours. */
  lifetimeHours: number;
}
