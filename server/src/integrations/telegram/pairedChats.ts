import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../../config.ts";

/** A private chat that was paired with this workstation's bot. */
export interface PairedChat {
  transportUserId: string;
  chatId: string;
  topicId: string | null;
  label: string;
}

export interface PairedChatStore {
  /** What was last remembered and for which bot, or null when nothing was. */
  read(): { botId: string; chats: PairedChat[] } | null;
  write(botId: string, chats: PairedChat[]): void;
}

/**
 * Pairing is a row in the database, and the database is the one piece of state
 * that gets swapped under a running install: a fresh file, a copy for a sandbox,
 * another path in `AGENT_CONSOLE_DB`. Each of those unpaired the phone without
 * saying so, and the first the operator knew of it was a question that never
 * arrived.
 *
 * So the pairing is remembered beside the bot token it belongs to, checkout
 * local and owner only, and the runtime puts it back at start. It names the bot
 * because a chat paired with one bot has never spoken to another, and Telegram
 * will not let a bot open that conversation: a different bot means pairing
 * again, and the runtime needs to be able to tell that this is what happened.
 */
export const TELEGRAM_PAIRED_CHATS_PATH = resolve(
  config.repoRoot,
  process.env.TELEGRAM_PAIRED_CHATS_FILE?.trim() || ".agent-console/telegram-paired-chats.json",
);

function isPairedChat(value: unknown): value is PairedChat {
  if (typeof value !== "object" || value === null) return false;
  const chat = value as Record<string, unknown>;
  return typeof chat.transportUserId === "string" && chat.transportUserId !== ""
    && typeof chat.chatId === "string" && chat.chatId !== ""
    && (chat.topicId === null || typeof chat.topicId === "string")
    && typeof chat.label === "string" && chat.label !== "";
}

export function filePairedChatStore(path = TELEGRAM_PAIRED_CHATS_PATH): PairedChatStore {
  return {
    read() {
      if (!existsSync(path)) return null;
      try {
        const stored = JSON.parse(readFileSync(path, "utf8")) as { botId?: unknown; chats?: unknown };
        if (typeof stored.botId !== "string" || stored.botId === "" || !Array.isArray(stored.chats)) return null;
        return { botId: stored.botId, chats: stored.chats.filter(isPairedChat) };
      } catch {
        // An unreadable file means nothing is remembered; pairing again rewrites it.
        return null;
      }
    },
    write(botId, chats) {
      const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        writeFileSync(temporary, `${JSON.stringify({ botId, chats }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
        chmodSync(path, 0o600);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    },
  };
}
