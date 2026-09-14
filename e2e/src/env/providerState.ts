import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/*
 * Real providers in T3 use the operator's own CLI state (docs/e2e-harness-plan.md 6.2). The Codex CLI
 * marks every directory it runs in as trusted in ~/.codex/config.toml, so each run would leave an entry
 * for a deleted temporary workspace. The harness removes exactly the entries under its own root.
 */

export const CODEX_CONFIG = join(homedir(), ".codex/config.toml");

export function forgetCodexTrust(harnessRoot: string, configPath = CODEX_CONFIG): number {
  if (!existsSync(configPath)) return 0;
  const text = readFileSync(configPath, "utf8");
  const escaped = harnessRoot.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const entry = new RegExp(`\\[projects\\."${escaped}/[^"\\n]*"\\]\\ntrust_level = "trusted"\\n(?:\\n)?`, "g");
  const removed = text.match(entry)?.length ?? 0;
  if (removed > 0) writeFileSync(configPath, text.replace(entry, ""));
  return removed;
}
