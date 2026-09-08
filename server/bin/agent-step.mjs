#!/usr/bin/env node
/**
 * The one door an agent has to this app's records.
 *
 * The contract used to be a Markdown block telling the agent to compose `curl`
 * calls with a bearer token and a hand-made requestId. That put four things a
 * model can get wrong between it and a status post — the URL, the header, the
 * JSON, and the uniqueness of the id — and a run that got any of them wrong
 * looked exactly like a run that never tried. The completion-audit subsystem
 * exists largely to clean up after that.
 *
 * This is deliberately boring: no dependencies, no imports from the server, one
 * file, so it works under whatever a provider's sandbox allows. It reads its
 * credentials from the environment, generates its own requestId, retries the
 * failures worth retrying, and exits non-zero with something the agent can act
 * on rather than a stack trace.
 *
 * Usage is printed by `agent-step` with no arguments.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.AGENT_CONSOLE_RUN_URL ?? "";
const TOKEN = process.env.AGENT_CONSOLE_RUN_TOKEN ?? "";

const USAGE = `agent-step — record progress and status for this work item.

  agent-step context [--full]               Re-read the authoritative work item context
                                            (--full: uncapped remarks and clarifications)
  agent-step state                          Everything recorded against it so far
  agent-step remark --kind KIND --text "…"  Bank what you just verified
  agent-step done --verification "…"        Finish: what you ran and what you observed
  agent-step blocked --reason "…" --action "…"
                                            Stop for a human: evidence, and the exact
                                            action only they can take
  agent-step continue --remaining "…" [--verified "…"]
                                            Hand over: what still has to happen, as
                                            instructions for the run that resumes this
                                            item on the same working tree
  agent-step decompose --file children.json Split into sub-steps

Remark kinds: PROGRESS, FINDING, DECISION_NEEDED, BLOCKER, VERIFICATION, COMPLETION.

Post a PROGRESS remark after each verified slice. It is how you see how much
budget is left, and it is what makes your work resumable if the run is stopped —
a run that banks nothing and is then stopped has produced nothing.

Before finishing you must post exactly one of 'done', 'continue' or 'blocked'.
A run that ends without one is recorded as unreported — not as success and not
as failure — and nobody can tell what it achieved.

'blocked' is for a concrete external dependency only a human can clear. Work
that simply is not finished yet is 'continue'.`;

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Flags as --key value, which is all this needs and the least a model gets wrong. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { args[key] = true; continue; }
    args[key] = next;
    i += 1;
  }
  return args;
}

/**
 * Retries only what is worth retrying: a connection refused because the server
 * is restarting, or a 5xx. A 4xx is the server saying the request itself is
 * wrong, and sending it again unchanged would just waste the run's budget.
 */
async function send(path, init, attempt = 0) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init?.headers },
    });
  } catch (error) {
    if (attempt >= 3) fail(`Could not reach the console at ${BASE}: ${error.message}`);
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    return send(path, init, attempt + 1);
  }
  if (response.status >= 500 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    return send(path, init, attempt + 1);
  }
  return response;
}

/** Turns the server's own error code into something to do about it. */
const ADVICE = {
  stale_status: "Someone else moved this work item. Run 'agent-step state' to see where it is now.",
  invalid_transition: "Only IN_PROGRESS may become DONE, BLOCKED or CONTINUE, and only once.",
  validation_error: "A required field was missing or empty.",
  request_id_conflict: "That requestId was already used for a different call.",
  invalid_run_token: "This run's credential has expired. The run is over; stop working.",
  consult_read_only: "This is a read-only run. It cannot post remarks or status.",
  verification_failed: "The server ran this item's Verify commands and at least one failed. Fix them, then post done again — or continue with what remains.",
  decompose_title_conflict: "Rename the conflicting titles and post again; existing sub-steps are kept.",
  decompose_depth_exceeded: "Finish this sub-step, or post continue with what remains.",
};

/** One readable block per failing Verify command (409 verification_failed). */
function formatVerificationFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return "";
  return failures.map((failure) => {
    const command = typeof failure?.command === "string" ? failure.command : "(unknown command)";
    const exit = failure?.exitCode === null || failure?.exitCode === undefined ? "killed" : String(failure.exitCode);
    const output = typeof failure?.output === "string" && failure.output.trim() !== ""
      ? failure.output.trim()
      : "(no output)";
    return `\n---\n$ ${command}\nexit ${exit}\n${output}`;
  }).join("") + "\n---";
}

/** Title collisions from a refused decompose (422 decompose_title_conflict). */
function formatDecomposeConflicts(conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) return "";
  return "\n" + conflicts.map((conflict) => {
    const index = typeof conflict?.index === "number" ? conflict.index : "?";
    const title = typeof conflict?.title === "string" ? conflict.title : "(untitled)";
    const existing = typeof conflict?.existing === "string" ? conflict.existing : "(unknown)";
    return `  children[${index}] "${title}" conflicts with ${existing}`;
  }).join("\n");
}

async function post(path, body) {
  const response = await send(path, {
    method: "POST",
    body: JSON.stringify({ requestId: randomUUID(), ...body }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON; the raw body is the message */ }
  if (!response.ok) {
    const code = parsed?.error?.code ?? String(response.status);
    const message = parsed?.error?.message ?? text;
    const advice = ADVICE[code];
    const detail = code === "verification_failed"
      ? formatVerificationFailures(parsed?.error?.failures)
      : code === "decompose_title_conflict"
        ? formatDecomposeConflicts(parsed?.error?.conflicts)
        : "";
    // Non-zero and specific. A silently swallowed refusal is how a run ends
    // believing it reported when it did not.
    fail(`agent-step: refused (${code}): ${message}${detail}${advice === undefined ? "" : `\n  ${advice}`}`, 2);
  }
  if (parsed?.budget !== undefined && parsed.budget !== null) {
    const b = parsed.budget;
    const warning = b.warning === undefined || b.warning === null ? "" : `  ${b.warning}`;
    process.stdout.write(`ok · budget: ${JSON.stringify(b)}${warning}\n`);
  } else {
    process.stdout.write("ok\n");
  }
}

async function get(path) {
  const response = await send(path, { method: "GET", headers: { Accept: "text/markdown" } });
  const text = await response.text();
  if (!response.ok) fail(`agent-step: ${response.status} ${text}`, 2);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (command === undefined || command === "help" || args.help === true) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(command === undefined ? 1 : 0);
}
if (BASE === "" || TOKEN === "") {
  fail("agent-step: AGENT_CONSOLE_RUN_URL and AGENT_CONSOLE_RUN_TOKEN are not set.\n"
    + "  This command only works inside a run started by the console.");
}

switch (command) {
  case "context": await get(args.full === true ? "/context?full=1" : "/context"); break;
  case "state": await get("/state"); break;
  case "remark": {
    const text = args.text ?? args.content;
    if (typeof text !== "string" || text.trim() === "") fail("agent-step remark needs --text \"what changed or was discovered\"");
    await post("/remarks", { kind: typeof args.kind === "string" ? args.kind.toUpperCase() : "PROGRESS", content: text });
    break;
  }
  case "done": {
    const verification = args.verification ?? args.evidence;
    if (typeof verification !== "string" || verification.trim() === "") {
      fail("agent-step done needs --verification \"the commands you ran and what you observed\".\n"
        + "  A claim with no evidence behind it is what the reviewer exists to catch.");
    }
    await post("/status", {
      expectedStatus: "IN_PROGRESS", status: "DONE",
      reason: typeof args.reason === "string" ? args.reason : "Completed",
      verificationSummary: verification,
    });
    break;
  }
  case "blocked": {
    const reason = args.reason;
    const action = args.action ?? args.verification;
    if (typeof reason !== "string" || reason.trim() === "") fail("agent-step blocked needs --reason \"observed evidence for why you cannot continue\"");
    if (typeof action !== "string" || action.trim() === "") {
      fail("agent-step blocked needs --action \"the exact action only the human can take\".\n"
        + "  Remaining implementation work is not a blocker; do it. This is for a concrete\n"
        + "  external dependency, after in-scope alternatives are exhausted.");
    }
    await post("/status", { expectedStatus: "IN_PROGRESS", status: "BLOCKED", reason, verificationSummary: action });
    break;
  }
  case "continue": {
    const remaining = args.remaining ?? args.reason;
    if (typeof remaining !== "string" || remaining.trim() === "") {
      fail("agent-step continue needs --remaining \"what still has to happen\".\n"
        + "  Write it as instructions for the run that picks this up on the same working\n"
        + "  tree: files, routes, commands, and what \"done\" looks like.");
    }
    await post("/status", {
      expectedStatus: "IN_PROGRESS", status: "CONTINUE",
      reason: remaining,
      verificationSummary: typeof args.verified === "string" ? args.verified : "",
    });
    break;
  }
  case "decompose": {
    if (typeof args.file !== "string") fail("agent-step decompose needs --file children.json");
    let payload;
    try { payload = JSON.parse(readFileSync(args.file, "utf8")); } catch (error) { fail(`Could not read ${args.file}: ${error.message}`); }
    const children = Array.isArray(payload) ? payload : payload.children;
    if (!Array.isArray(children)) fail("The file must be a JSON array of {title, content}, or an object with a 'children' array.");
    await post("/decompose", { children, resumeBrief: payload.resumeBrief ?? args.brief ?? "" });
    break;
  }
  default:
    fail(`agent-step: unknown command "${command}"\n\n${USAGE}`);
}
