import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { ProviderId } from "@hydra/shared";
import { resolveBinary } from "../infrastructure/process.ts";

export const PROVIDER_COMMANDS: Record<
  Exclude<ProviderId, "claude">,
  string
> = {
  codex: "codex",
  cursor: "cursor-agent",
  grok: "grok",
  copilot: "copilot",
  kilocode: "kilo",
};

export function providerInstallPrefix(id: ProviderId): string {
  const data =
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return resolve(data, "hydra-cli", id);
}

export function providerBinaryCandidates(
  id: ProviderId,
  command: string,
): string[] {
  if (id === "claude" || command !== PROVIDER_COMMANDS[id]) return [];
  const name = process.platform === "win32" ? `${command}.cmd` : command;
  const prefix = providerInstallPrefix(id);
  return [
    join(prefix, "node_modules", ".bin", name),
    join(
      prefix,
      "bin",
      process.platform === "win32" ? `${command}.exe` : command,
    ),
    ...(id === "cursor"
      ? [
          join(
            homedir(),
            ".local",
            "bin",
            process.platform === "win32" ? `${command}.exe` : command,
          ),
        ]
      : []),
    ...(id === "grok"
      ? [
          join(
            homedir(),
            ".grok",
            "bin",
            process.platform === "win32" ? `${command}.exe` : command,
          ),
        ]
      : []),
  ];
}

export async function resolveProviderBinary(
  id: ProviderId,
  command: string,
): Promise<string | null> {
  const existing = await resolveBinary(command);
  if (existing !== null) return existing;
  for (const candidate of providerBinaryCandidates(id, command)) {
    const binary = await resolveBinary(candidate);
    if (binary !== null) return binary;
  }
  return null;
}

export function providerInstallPath(id: ProviderId): string {
  return [
    join(providerInstallPrefix(id), "node_modules", ".bin"),
    join(providerInstallPrefix(id), "bin"),
    process.env.PATH ?? "",
  ].join(delimiter);
}
