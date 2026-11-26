#!/usr/bin/env node
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "shell-quote";
import { fileURLToPath } from "node:url";

const inside = (root, path) => { const r = relative(root, path); return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r)); };
function canonical(path) {
  try { return realpathSync(path); }
  catch { const parent = dirname(path); return parent === path ? path : resolve(canonical(parent), relative(parent, path)); }
}
const deny = reason => ({ permission: "deny", user_message: reason, agent_message: reason });

function shellDecision(input, config) {
  const command = input.command;
  if (typeof command !== "string" || command.length > 32000) return deny("Missing or oversized shell command.");
  if (command.includes("HYDRA_POLICY_PROBE_")) return deny("Platform command-policy probe refused.");
  const p = config.policy;
  if (p.verification !== "deferred" && p.editFiles && p.build && p.generateContracts) return { permission: "allow" };
  const handoff = `Station policy: verification belongs to ${p.verifier ?? "the Verify station"}. Use approved managed commands, or record the outstanding check and hand off.`;
  const cwd = input.cwd ?? input.working_directory ?? input.workingDirectory ?? config.root;
  if (typeof cwd !== "string" || !inside(config.root, canonical(resolve(config.root, cwd)))) return deny("Command working directory is outside this workspace.");
  if (/[\n\r`$<>\\(){}]/.test(command)) return deny(handoff);
  let tokens;
  try { tokens = parse(command); } catch { return deny("Cannot parse command; use one plain approved command."); }
  const commands = [[]];
  for (const token of tokens) {
    if (typeof token === "string") commands.at(-1).push(token);
    else if (token.op && ["&&", ";", "|"].includes(token.op)) commands.push([]);
    else return deny(handoff);
  }
  if (commands.some(args => !args.length)) return deny(handoff);
  for (const args of commands) {
    const [bin, ...rest] = args;
    if (["ls", "pwd", "cat", "head", "tail", "wc", "rg", "grep", "diff"].includes(bin)) {
      if (rest.some(arg => /^(--pre(?:=|$)|--hostname-bin(?:=|$))/.test(arg))) return deny(handoff);
      continue;
    }
    if (bin === "git" && ["status", "diff", "show", "log", "ls-files", "rev-parse"].includes(rest[0])
      && !rest.some(arg => /^(--ext-diff|--textconv|--output|--no-index)(=|$)/.test(arg))) continue;
    if (bin === config.launcher && (rest.length === 0 || ["inbox", "context", "state", "execution", "remark", "reply", "checkpoint", "done", "continue", "blocked", "ask", "decompose", "plan", "help", "--help", "-h"].includes(rest[0])
      || (p.verification === "allowed" && ["check", "repair-verify"].includes(rest[0])))) {
      continue;
    }
    if (bin === "npm" && rest[0] === "run") {
      if (p.generateContracts && JSON.stringify(rest) === JSON.stringify(["run", "agent:run", "--", "contracts"])) continue;
      if (p.build && rest[1] === "agent:build" && rest[2] === "--" && rest.length === 4
        && /^[\w./-]+\.csproj$/.test(rest[3]) && inside(config.root, canonical(resolve(config.root, rest[3])))) continue;
    }
    return deny(handoff);
  }
  return { permission: "allow" };
}

function decide(input, config) {
  const event = input.hook_event_name;
  const name = String(input.tool_name ?? "").toLowerCase();
  if (event === "beforeShellExecution" || name === "shell" || name === "bash") return shellDecision(input.tool_input ?? input, config);
  if (["todowrite", "updatetodos"].includes(name)) return { permission: "allow" };
  if (/write|edit|delete|replace/.test(name)) {
    if (!config.policy.editFiles) return deny("File edits are forbidden in this station.");
    const payload = input.tool_input ?? {};
    const target = payload.path ?? payload.file_path ?? payload.target_file;
    if (typeof target !== "string") return deny("Cannot authorize an edit without its target path.");
    const path = canonical(resolve(config.root, target));
    const rel = relative(config.root, path).split(sep).join("/");
    const restricted = config.policy.verification === "deferred" || !config.policy.build || !config.policy.generateContracts;
    if (!inside(config.root, path) || /(^|\/)(\.cursor|\.git)(\/|$)/.test(rel)
      || /(^|\/)(AGENTS\.md|CLAUDE\.md)$/.test(rel)
      || (restricted && (/(^|\/)(package\.json|package-lock\.json)$/.test(rel) || rel === "scripts/agent-command.mjs"))
      || path === canonical(fileURLToPath(import.meta.url)) || inside(config.directory, path)) return deny("Platform policy and command entrypoints cannot be edited by this run.");
    return { permission: "allow" };
  }
  if (config.policy.verification === "deferred" && event === "preToolUse"
    && !["read", "readfile", "grep", "glob", "ls", "listdir", "readlints", "getmcptools", "await", "taskoutput"].includes(name))
    return deny("This tool has no station authorization; use repository inspection or hand off pending checks.");
  return { permission: "allow" };
}

const manifestPath = process.argv[2] ?? process.env.HYDRA_CURSOR_POLICY;
if (!manifestPath) { process.stdout.write(JSON.stringify({ permission: "allow" })); process.exit(0); }
try {
  const config = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (config.policy?.version !== 1 || !["allowed", "deferred"].includes(config.policy.verification)
    || ["editFiles", "build", "generateContracts"].some(key => typeof config.policy[key] !== "boolean")
    || !isAbsolute(config.root) || !isAbsolute(config.directory)) throw new Error("Invalid policy manifest");
  const input = JSON.parse(readFileSync(0, "utf8"));
  const decision = decide(input, config);
  appendFileSync(config.audit, JSON.stringify({ at: new Date().toISOString(), event: input.hook_event_name,
    permission: decision.permission, probe: JSON.stringify(input).includes("HYDRA_POLICY_PROBE_") }) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify(decision));
} catch {
  process.stdout.write(JSON.stringify(deny("Platform policy unavailable or invalid; execution refused.")));
  process.exitCode = 2;
}
