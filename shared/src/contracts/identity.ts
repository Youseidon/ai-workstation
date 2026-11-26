export interface UserIdentity {
  id: string;
  username: string;
  ownsLegacyData: boolean;
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
