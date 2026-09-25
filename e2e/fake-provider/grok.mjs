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
 * Saved tasks reach it on one of two channels, chosen by the server from this
 * provider's reachability (server/src/runService.ts, executeChannel). The work
 * item itself is inlined in the prompt on both; what differs is how the run
 * reports back:
 *   shim    - the prompt names an `agent-step` launcher. The fake runs it, the
 *             way a real agent would, and the launcher makes the HTTP call.
 *   offline - the sandbox has no route to the console, so the prompt carries the
 *             offline protocol and the fake reports in a final agent-status
 *             block with no HTTP call from anything.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * The launcher the prompt names, or null when this run was not given one. The
 * path is quoted on its own line under the contract heading, which is how the
 * product writes it (server/src/agentContext.ts, progressApiMarkdown).
 */
function shimPath(prompt) {
  const match = prompt.match(/## Recording your progress\n\n"([^"\n]+)"\n/);
  return match ? match[1] : null;
}

/**
 * Runs the launcher the way an agent would: a child process the fake does not
 * make the HTTP call for. Its exit code is the only thing an agent gets back, so
 * a refusal is fatal here for the same reason it was when the call was a curl.
 */
function step(path, args) {
  // Logged before the run, not only after: the console ends the provider as soon
  // as a terminal status lands, so a fake that only logged results would have no
  // record of the one call that mattered.
  log({ event: "exec", command: args[0], args: args.slice(1) });
  const result = spawnSync(path, args, { encoding: "utf8" });
  const entry = {
    event: "shim",
    command: args[0],
    args: args.slice(1),
    code: result.status,
    signal: result.signal ?? null,
    stderr: (result.stderr ?? "").trim().slice(0, 400),
  };
  log(entry);
  if (result.error) throw new Error(`could not run the launcher ${path}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${path} ${args[0]} exited ${result.status}: ${entry.stderr || "(no stderr)"}`);
  return result.stdout ?? "";
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
  const shim = shimPath(prompt);
  const offline = prompt.includes("## Offline completion reporting");
  const channel = shim ? "shim" : offline ? "offline" : "custom";
  // Names only, never values: proves which secrets an agent process could have read.
  const inheritedSecrets = Object.keys(process.env).filter((name) => /TOKEN|SECRET|API_KEY|PASSWORD/i.test(name));
  log({ event: "start", behavior: scenario.behavior, channel, shim, cwd: flags["--cwd"], permissionMode: flags["--permission-mode"], sandbox: flags["--sandbox"], inheritedSecrets });

  emit({ type: "system", subtype: "init", sessionId: `fake-${process.pid}` });
  emit({ type: "thought", data: `Fake agent running scenario ${scenario.behavior} on the ${channel} channel.` });

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

  // The work item is inlined in the prompt on both channels, so there is nothing
  // to fetch: a run that reads 0 characters here is a run whose prompt the fake
  // did not recognise, which is what gap M-9 was.
  const context = channel === "custom" ? "" : prompt;
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
    // L3 A2: options are reported by the agent with its blocking status, never generated later.
    if (scenario.options) status.options = scenario.options;
  }

  if (shim) {
    const remarkKind = scenario.remarkKind ?? (status.status === "BLOCKED" ? "DECISION_NEEDED" : "PROGRESS");
    const remark = scenario.remark ?? (status.status === "BLOCKED" ? status.reason : "Fake agent made progress.");
    step(shim, ["remark", "--kind", remarkKind, "--text", remark]);
    if (!scenario.skipStatus) {
      if (status.status === "DONE") {
        step(shim, ["done", "--verification", status.verificationSummary, "--reason", status.reason]);
      } else {
        // The options are written to a file the way the contract asks for them,
        // and only when the scenario has any: an empty file would claim the agent
        // weighed nothing rather than that it weighed nothing worth reporting.
        const optionsFile = scenario.options ? join(mkdtempSync(join(tmpdir(), "fake-grok-options-")), "options.json") : null;
        if (optionsFile) writeFileSync(optionsFile, JSON.stringify(scenario.options));
        try {
          step(shim, ["blocked", "--reason", status.reason, "--action", status.verificationSummary, ...(optionsFile ? ["--options-file", optionsFile] : [])]);
        } finally {
          if (optionsFile) rmSync(optionsFile, { recursive: true, force: true });
        }
      }
    }
    finish(status.status === "DONE" ? "Done." : "Blocked; waiting for the owner.");
  } else if (offline) {
    const { requestId: _requestId, expectedStatus: _expected, ...report } = status;
    const block = scenario.malformedStatus ? statusBlock({ status: report.status }) : scenario.skipStatus ? "" : statusBlock(report);
    finish(`${status.status === "DONE" ? "Done." : "Blocked."}${block}`);
  } else {
    finish(scenario.text ?? "Done.");
  }
  log({ event: "exit", code: 0, status: status.status });
}

run().catch((error) => fatal(error instanceof Error ? error.message : String(error)));
