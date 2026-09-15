#!/usr/bin/env node
/*
 * Fake Grok CLI for the end-to-end harness (docs/e2e-harness-plan.md 4.3).
 *
 * Speaks `grok -p --output-format streaming-json` NDJSON, so the server's real
 * spawn, stream parsing and completion code runs unchanged. Behaviour comes
 * from the next scenario in $FAKE_PROVIDER_DIR/queue.json:
 *
 *   done | block-on-decision | fail | hang-until-stopped | crash-after-spawn | consume-answer
 *
 * Saved tasks reach it on one of two paths, chosen by the server:
 *   live   - the prompt carries a curl command for the Progress API; the fake
 *            fetches context and posts remarks and status over HTTP.
 *   inline - the prompt embeds the context and the offline completion
 *            protocol; the fake reports status in a final agent-status block.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = "grok 1.0.5";
const BEHAVIOURS = new Set(["done", "block-on-decision", "fail", "hang-until-stopped", "crash-after-spawn", "consume-answer"]);
const dir = process.env.FAKE_PROVIDER_DIR;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function log(entry) {
  if (!dir) return;
  const safe = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }).replace(/Bearer [A-Za-z0-9_-]+/g, "Bearer [REDACTED]");
  appendFileSync(join(dir, "fake-provider.log"), `${safe}\n`);
}

function fatal(message) {
  log({ event: "fatal", message });
  emit({ type: "error", error: { message } });
  process.exit(2);
}

function parseArgs(argv) {
  const args = { prompt: null, flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-p") args.prompt = argv[++i] ?? "";
    else if (arg.startsWith("--") || arg === "-m") args.flags[arg] = argv[++i];
  }
  return args;
}

/** Pops the next scenario; renames the queue so two concurrent runs never take the same one. */
function nextScenario() {
  if (!dir) fatal("FAKE_PROVIDER_DIR is not set");
  const queue = join(dir, "queue.json");
  const claimed = join(dir, `queue.${process.pid}.claim`);
  try {
    renameSync(queue, claimed);
  } catch {
    fatal(`no scenario queued in ${queue}`);
  }
  let items;
  try {
    items = JSON.parse(readFileSync(claimed, "utf8"));
  } catch (error) {
    renameSync(claimed, queue);
    fatal(`scenario queue is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(items) || items.length === 0) fatal("scenario queue is empty");
  const [scenario, ...rest] = items;
  writeFileSync(queue, JSON.stringify(rest));
  if (existsSync(claimed)) renameSync(claimed, `${claimed}.done`);
  if (!scenario || !BEHAVIOURS.has(scenario.behavior)) fatal(`unknown scenario behaviour: ${JSON.stringify(scenario?.behavior)}`);
  return scenario;
}

function livePath(prompt) {
  const match = prompt.match(/curl -fsS -H 'Authorization: Bearer ([A-Za-z0-9_-]+)' (\S+\/context)\b/);
  return match ? { token: match[1], contextUrl: match[2] } : null;
}

async function http(method, url, token, body) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  log({ event: "http", method, path: new URL(url).pathname, host: new URL(url).host, status: response.status });
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname} -> ${response.status} ${text.slice(0, 200)}`);
  return text;
}

function toolCall(id, name, input, output) {
  emit({ type: "tool_call", toolCallId: id, toolName: name, status: "pending", rawInput: input });
  emit({ type: "tool_call_update", toolCallId: id, status: null });
  emit({ type: "tool_call_update", toolCallId: id, status: "completed", rawOutput: output });
}

function finish(text) {
  emit({ type: "text", data: text });
  emit({ type: "usage", usage: { input_tokens: 1200, output_tokens: 80 } });
  emit({ type: "end", stopReason: "end_turn", usage: { input_tokens: 1200, output_tokens: 80 } });
}

const statusBlock = (status) => `\n\n\`\`\`agent-status\n${JSON.stringify(status)}\n\`\`\`\n`;

async function run() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const { prompt, flags } = parseArgs(argv);
  if (prompt === null) fatal("fake grok expects -p <prompt>");
  const scenario = nextScenario();
  const live = livePath(prompt);
  const inline = prompt.includes("## Offline completion reporting");
  const path = live ? "live" : inline ? "inline" : "custom";
  // Names only, never values: proves which secrets an agent process could have read.
  const inheritedSecrets = Object.keys(process.env).filter((name) => /TOKEN|SECRET|API_KEY|PASSWORD/i.test(name));
  log({ event: "start", behavior: scenario.behavior, path, cwd: flags["--cwd"], permissionMode: flags["--permission-mode"], sandbox: flags["--sandbox"], inheritedSecrets });

  emit({ type: "system", subtype: "init", sessionId: `fake-${process.pid}` });
  emit({ type: "thought", data: `Fake agent running scenario ${scenario.behavior} on the ${path} path.` });

  if (scenario.behavior === "crash-after-spawn") {
    log({ event: "crash" });
    process.kill(process.pid, "SIGKILL");
    return;
  }
  if (scenario.behavior === "hang-until-stopped") {
    await new Promise((resolve) => {
      process.on("SIGINT", () => {
        log({ event: "signal", signal: "SIGINT", ignored: scenario.ignoreSigint === true });
        if (scenario.ignoreSigint) return;
        emit({ type: "end", stopReason: "cancelled" });
        resolve();
        process.exit(130);
      });
      setInterval(() => emit({ type: "tool_call_update", toolCallId: "wait", status: null }), 500);
    });
    return;
  }

  let context = "";
  if (live) {
    context = await http("GET", live.contextUrl, live.token);
    toolCall("ctx", "web_fetch", { url: live.contextUrl }, context.slice(0, 200));
  } else if (inline) {
    context = prompt;
  }
  log({ event: "context", chars: context.length, containsExpected: scenario.expectInContext ? context.includes(scenario.expectInContext) : null });

  if (scenario.behavior === "fail") {
    emit({ type: "text", data: scenario.text ?? "Something went wrong in the fake agent." });
    log({ event: "exit", code: 1 });
    process.exit(1);
  }

  let status;
  if (scenario.behavior === "consume-answer") {
    if (!scenario.expectInContext || !context.includes(scenario.expectInContext)) {
      emit({ type: "error", error: { message: `expected answer not found in context: ${scenario.expectInContext}` } });
      log({ event: "exit", code: 1, reason: "answer missing" });
      process.exit(1);
    }
    status = { requestId: `fake-status-${process.pid}`, expectedStatus: "IN_PROGRESS", status: "DONE", reason: "Completed", verificationSummary: scenario.verificationSummary ?? `Used the saved answer: ${scenario.expectInContext}` };
  } else if (scenario.behavior === "done") {
    status = { requestId: `fake-status-${process.pid}`, expectedStatus: "IN_PROGRESS", status: "DONE", reason: "Completed", verificationSummary: scenario.verificationSummary ?? "Fake agent verified its work." };
  } else {
    status = { requestId: `fake-status-${process.pid}`, expectedStatus: "IN_PROGRESS", status: "BLOCKED", reason: scenario.reason ?? "The task needs an owner decision the agent cannot make.", verificationSummary: scenario.humanAction ?? "Choose which option to ship." };
  }

  if (live) {
    const base = live.contextUrl.replace(/\/context$/, "");
    const remarkKind = scenario.remarkKind ?? (status.status === "BLOCKED" ? "DECISION_NEEDED" : "PROGRESS");
    const remark = scenario.remark ?? (status.status === "BLOCKED" ? status.reason : "Fake agent made progress.");
    await http("POST", `${base}/remarks`, live.token, { requestId: `fake-remark-${process.pid}`, kind: remarkKind, content: remark });
    if (!scenario.skipStatus) await http("POST", `${base}/status`, live.token, status);
    finish(status.status === "DONE" ? "Done." : "Blocked; waiting for the owner.");
  } else if (inline) {
    const { requestId: _requestId, expectedStatus: _expected, ...report } = status;
    const block = scenario.malformedStatus ? statusBlock({ status: report.status }) : scenario.skipStatus ? "" : statusBlock(report);
    finish(`${status.status === "DONE" ? "Done." : "Blocked."}${block}`);
  } else {
    finish(scenario.text ?? "Done.");
  }
  log({ event: "exit", code: 0, status: status.status });
}

run().catch((error) => fatal(error instanceof Error ? error.message : String(error)));
