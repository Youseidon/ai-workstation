import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/*
 * `.claude/settings.json` permission rules (`Bash(pattern)`, `Read(pattern)`, ...)
 * are enforced by the interactive Claude Code CLI, not by the Agent SDK when run
 * in-process the way this console does. Without a `canUseTool` callback the SDK
 * has no headless approval path at all, so every non-trivial tool call is denied
 * regardless of what the project's settings.json says. This module re-implements
 * that rule matching so `.claude/settings.json` behaves the way its authors expect
 * in a headless pipeline run.
 */

interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

interface ParsedRule {
  tool: string;
  pattern: string;
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);
const MUTATING_FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

function readRules(path: string): PermissionRules {
  if (!existsSync(path)) return { allow: [], deny: [], ask: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { permissions?: Record<string, unknown> };
    const perms = raw.permissions ?? {};
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
    return { allow: strings(perms.allow), deny: strings(perms.deny), ask: strings(perms.ask) };
  } catch {
    return { allow: [], deny: [], ask: [] };
  }
}

/** Merges user, project, and local settings.json permission rules (same layering the CLI documents). */
export function loadMergedPermissionRules(cwd: string): PermissionRules {
  const sources = [join(homedir(), ".claude", "settings.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")];
  const merged: PermissionRules = { allow: [], deny: [], ask: [] };
  for (const source of sources) {
    const rules = readRules(source);
    merged.allow.push(...rules.allow);
    merged.deny.push(...rules.deny);
    merged.ask.push(...rules.ask);
  }
  return merged;
}

function parseRule(rule: string): ParsedRule | null {
  const match = rule.match(/^([A-Za-z]+)\((.*)\)$/);
  if (match) return { tool: match[1]!, pattern: match[2]! };
  if (/^[A-Za-z]+$/.test(rule)) return { tool: rule, pattern: "*" };
  return null;
}

function escapeRegExpLiteral(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Bash command patterns: `*` matches anything (including `/`), no `**` distinction. */
function bashPatternRegExp(pattern: string): RegExp {
  let out = "";
  for (const char of pattern) out += char === "*" ? ".*" : escapeRegExpLiteral(char);
  return new RegExp(`^${out}$`, "s");
}

/** File path patterns: gitignore-style, `**` crosses `/`, single `*` does not. */
function pathPatternRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i += 2;
      continue;
    }
    if (pattern[i] === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    out += escapeRegExpLiteral(pattern[i]!);
    i += 1;
  }
  return new RegExp(`^${out}$`, "s");
}

/** Best-effort split on unquoted `&&`, `||`, `;`, `|` so each chained subcommand is checked independently. */
function splitBashSubcommands(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if ((char === "&" && command[i + 1] === "&") || (char === "|" && command[i + 1] === "|")) {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (char === ";" || char === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

type Verdict = "deny" | "ask" | "allow" | "unmatched";

function matchesAnyBash(rules: string[], command: string): boolean {
  return rules.some((rule) => {
    const parsed = parseRule(rule);
    return parsed !== null && parsed.tool === "Bash" && bashPatternRegExp(parsed.pattern).test(command);
  });
}

function bashVerdict(rules: PermissionRules, command: string): Verdict {
  const subcommands = splitBashSubcommands(command);
  if (matchesAnyBash(rules.deny, command) || subcommands.some((sub) => matchesAnyBash(rules.deny, sub))) return "deny";
  if (matchesAnyBash(rules.ask, command) || subcommands.some((sub) => matchesAnyBash(rules.ask, sub))) return "ask";
  if (matchesAnyBash(rules.allow, command)) return "allow";
  if (subcommands.length > 0 && subcommands.every((sub) => matchesAnyBash(rules.allow, sub))) return "allow";
  return "unmatched";
}

// The Read/Edit/Write tools always receive an absolute file_path, but settings.json
// patterns are usually written relative to the project root (e.g. Read(.env)),
// sometimes as a bare filename. This builds every form a pattern might have been
// written against: the absolute path, the path relative to cwd, and (deny-only)
// the basename, so a rule like Read(.env) still catches <cwd>/.env and a
// Read(**/credentials*)-style glob still catches nested files.
function pathCandidates(cwd: string, filePath: string, includeBasename: boolean): string[] {
  const candidates = [filePath];
  const cwdPrefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (filePath.startsWith(cwdPrefix)) candidates.push(filePath.slice(cwdPrefix.length));
  if (includeBasename) candidates.push(filePath.slice(filePath.lastIndexOf("/") + 1));
  return candidates;
}

function matchesAnyPath(rules: string[], tool: string, candidates: string[]): boolean {
  return rules.some((rule) => {
    const parsed = parseRule(rule);
    if (parsed === null || parsed.tool !== tool) return false;
    const regExp = pathPatternRegExp(parsed.pattern);
    return candidates.some((candidate) => regExp.test(candidate));
  });
}

function fileVerdict(rules: PermissionRules, tool: string, cwd: string, filePath: string): Verdict {
  // Deny matches broadly (absolute, relative, and basename) so a narrow secret-file
  // pattern still catches the file wherever it turns up. Allow/ask stay narrower
  // (no basename) so a bare-filename allow rule can't accidentally widen to every
  // same-named file in the tree.
  if (matchesAnyPath(rules.deny, tool, pathCandidates(cwd, filePath, true))) return "deny";
  const narrow = pathCandidates(cwd, filePath, false);
  if (matchesAnyPath(rules.ask, tool, narrow)) return "ask";
  if (matchesAnyPath(rules.allow, tool, narrow)) return "allow";
  return "unmatched";
}

const deny = (message: string): PermissionResult => ({ behavior: "deny", message, interrupt: false });
const allow = (input: Record<string, unknown>): PermissionResult => ({ behavior: "allow", updatedInput: input });

/**
 * Builds a `canUseTool` callback that enforces the target directory's
 * `.claude/settings.json` permission rules the way the interactive CLI would,
 * with headless-safe fallbacks: `ask` rules and unmatched Bash/network calls
 * deny (there is no one to prompt), unmatched file edits follow `permissionMode`.
 */
export function buildCanUseTool(cwd: string, permissionMode: string): CanUseTool {
  return async (toolName, input) => {
    // Re-read on every call rather than once per run: a prompt can (and did, in
    // testing) edit its own .claude/settings.json mid-run to add a rule, and that
    // edit should take effect for the very next tool call, not the next run.
    const rules = loadMergedPermissionRules(cwd);
    if (toolName === "Bash" && typeof input.command === "string") {
      const verdict = bashVerdict(rules, input.command);
      if (verdict === "deny") return deny("Blocked by a permissions.deny rule in .claude/settings.json.");
      if (verdict === "allow") return allow(input);
      if (verdict === "ask") return deny("This command needs human approval (permissions.ask) and cannot be approved in a headless run.");
      return deny(
        "This command is not pre-approved for unattended execution. Add a matching Bash(...) pattern to permissions.allow in .claude/settings.json to enable it in pipeline runs.",
      );
    }
    if (FILE_TOOLS.has(toolName) && typeof input.file_path === "string") {
      const verdict = fileVerdict(rules, toolName, cwd, input.file_path);
      if (verdict === "deny") return deny("Blocked by a permissions.deny rule in .claude/settings.json.");
      if (verdict === "allow") return allow(input);
      if (verdict === "ask") return deny("This file access needs human approval (permissions.ask) and cannot be approved in a headless run.");
      if (toolName === "Read") return allow(input);
      if (MUTATING_FILE_TOOLS.has(toolName) && permissionMode === "acceptEdits") return allow(input);
      return deny(`${toolName} is not pre-approved for this path and the current permission mode (${permissionMode}) does not auto-accept edits.`);
    }
    return allow(input);
  };
}
