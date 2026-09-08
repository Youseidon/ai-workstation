/**
 * Parse a work item's `## Verify` block into shell commands the server will run
 * on `done`.
 *
 * Pure: no I/O, no database. The same function feeds the save path (which
 * writes COMMAND criteria) and the item editor (which shows them read-only),
 * so the two cannot disagree about what the text says.
 */

import {
  DOD_COMMAND_MAX_LENGTH,
  DOD_COMMAND_TIMEOUT_DEFAULT_MS,
  clampDodTimeout,
} from "./statusModel";

export interface VerifyCommand {
  /** The shell line, with a trailing `# timeout=…` comment stripped. */
  text: string;
  timeoutMs: number;
}

export interface VerifyBlockParse {
  /** Commands in document order. Empty when there is no usable Verify block. */
  commands: VerifyCommand[];
  /**
   * Lines that exceed `DOD_COMMAND_MAX_LENGTH`. The save path turns these into
   * a 422; the editor can surface them without round-tripping the server.
   */
  tooLong: string[];
}

const HEADING = /^##\s+(.*)$/;
const FENCE_OPEN = /^```(sh|bash)[ \t]*$/i;
const FENCE_CLOSE = /^```[ \t]*$/;
const TIMEOUT_COMMENT = /^(.*?)(?:\s+#\s*timeout\s*=\s*(\d+(?:\.\d+)?)(s|ms|m)?)\s*$/i;

/**
 * Find the last `## ` heading whose text starts with `Verify`, take the first
 * fenced `sh`/`bash` block between it and the next `## ` heading, and turn each
 * non-empty, non-comment line into a command.
 *
 * Prose between the heading and the fence is ignored. No fenced block → no
 * criteria. A trailing `# timeout=600s` (or `ms` / bare seconds) sets the
 * criterion timeout; the comment is stripped from `text`. Leading `VAR=value`
 * assignments stay in the line — `shell: true` passes them through unchanged.
 */
export function parseVerifyBlock(content: string): VerifyBlockParse {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let verifyStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]!.match(HEADING);
    if (match !== null && /^\s*Verify\b/i.test(match[1] ?? "")) verifyStart = i;
  }
  if (verifyStart < 0) return { commands: [], tooLong: [] };

  let sectionEnd = lines.length;
  for (let i = verifyStart + 1; i < lines.length; i += 1) {
    if (HEADING.test(lines[i]!)) { sectionEnd = i; break; }
  }

  let fenceStart = -1;
  let fenceEnd = -1;
  for (let i = verifyStart + 1; i < sectionEnd; i += 1) {
    if (FENCE_OPEN.test(lines[i]!)) { fenceStart = i; break; }
  }
  if (fenceStart < 0) return { commands: [], tooLong: [] };
  for (let i = fenceStart + 1; i < sectionEnd; i += 1) {
    if (FENCE_CLOSE.test(lines[i]!)) { fenceEnd = i; break; }
  }
  if (fenceEnd < 0) return { commands: [], tooLong: [] };

  const commands: VerifyCommand[] = [];
  const tooLong: string[] = [];
  for (let i = fenceStart + 1; i < fenceEnd; i += 1) {
    const raw = lines[i]!.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    const parsed = parseCommandLine(raw);
    if (parsed.text.length > DOD_COMMAND_MAX_LENGTH) {
      tooLong.push(parsed.text);
      continue;
    }
    commands.push(parsed);
  }
  return { commands, tooLong };
}

function parseCommandLine(raw: string): VerifyCommand {
  const match = raw.match(TIMEOUT_COMMENT);
  if (match === null) {
    return { text: raw, timeoutMs: DOD_COMMAND_TIMEOUT_DEFAULT_MS };
  }
  const text = (match[1] ?? "").trim();
  const amount = Number(match[2]);
  const unit = (match[3] ?? "s").toLowerCase();
  const ms = unit === "ms" ? amount : unit === "m" ? amount * 60_000 : amount * 1_000;
  return { text, timeoutMs: clampDodTimeout(ms) };
}
