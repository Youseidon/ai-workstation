/**
 * Disposable-DB check for prompt 07: re-decompose append + title conflict.
 * Run: AGENT_CONSOLE_DB=/tmp/verify-07.sqlite node --import tsx scripts/verify-07-decompose.ts
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportedProgram } from "../server/src/promptImport.ts";
import { newId } from "../server/src/lib/ids.ts";
import { runContexts } from "../server/src/runContext.ts";
import { WorkspaceError, workspaces } from "../server/src/workspaces.ts";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "verify-07-"));
  const workspace = workspaces.create({ name: "verify-07", description: "", workDirectory: dir });
  const pack: ImportedProgram = {
    key: "V07",
    name: "Verify",
    overview: "",
    workspaceDescription: "",
    suites: [{
      key: "S6",
      name: "Modules",
      prompts: [{
        key: "S6-08",
        title: "Parent station",
        content: "Split remaining endpoints.",
        status: "TODO",
        completedAt: null,
        result: "",
        isGate: false,
      }],
    }],
    dependencies: [],
    gates: [],
    warnings: [],
  };
  workspaces.importProgram(workspace.id, pack);
  const parent = workspaces.tree(workspace.id).programs[0]!.suites[0]!.prompts[0]!;

  function begin(promptId: number): { runId: string; token: string } {
    const runId = newId("run");
    const credential = runContexts.create(runId, workspace.id, promptId);
    workspaces.beginAgentRun({
      runId, workspaceId: workspace.id, promptId, provider: "claude", model: null,
      tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute",
    });
    workspaces.markAgentRunRunning(runId);
    return { runId, token: credential.token };
  }

  function children() {
    return workspaces.promptOptions(workspace.id)
      .filter((p) => p.parentPromptId === parent.id)
      .sort((a, b) => a.childOrder - b.childOrder)
      .map((p) => ({
        key: p.externalKey,
        title: p.title,
        status: p.status,
        childOrder: p.childOrder,
      }));
  }

  const first = begin(parent.id);
  workspaces.decomposePrompt(first.runId, {
    requestId: "dec-first-batch",
    resumeBrief: "first three",
    children: [
      { title: "Endpoint A", content: "do A" },
      { title: "Endpoint B", content: "do B" },
      { title: "Endpoint C", content: "do C" },
    ],
  });
  workspaces.finishAgentRun(first.runId, "done");

  for (const child of workspaces.promptOptions(workspace.id).filter((p) => p.parentPromptId === parent.id)) {
    workspaces.skipPrompt(child.id, "USER", `closed for resume: ${child.title}`);
  }

  const resume = begin(parent.id);

  // Mini agent-door with the same 422 JSON shape as server/src/index.ts.
  const port = 4137;
  const server = createServer((req, res) => {
    const match = req.url?.match(/^\/api\/agent\/runs\/([^/]+)\/decompose$/);
    if (req.method !== "POST" || match === null) {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const memory = runContexts.authenticate(match[1]!, token);
    if (!memory) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "invalid_run_token", message: "bad token" } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const result = workspaces.decomposePrompt(match[1]!, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        const status = error instanceof WorkspaceError ? error.status : 400;
        const code = error instanceof WorkspaceError ? error.code : "invalid_request";
        const message = error instanceof Error ? error.message : String(error);
        const details = error instanceof WorkspaceError ? (error.details ?? {}) : {};
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code, message, ...details } }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const conflictRes = await fetch(`http://127.0.0.1:${port}/api/agent/runs/${resume.runId}/decompose`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resume.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId: "dec-dup-title",
      resumeBrief: "should refuse",
      children: [
        { title: "Endpoint A", content: "duplicate" },
        { title: "Endpoint D", content: "new" },
      ],
    }),
  });
  const conflictBody = await conflictRes.json();

  console.log("--- 422 body (duplicated title, via HTTP) ---");
  console.log("HTTP", conflictRes.status);
  console.log(JSON.stringify(conflictBody, null, 2));
  console.log("parent status after refusal:", workspaces.promptOutcome(parent.id).status);
  console.log("children after refusal:", JSON.stringify(children(), null, 2));

  const accepted = workspaces.decomposePrompt(resume.runId, {
    requestId: "dec-ok-append",
    resumeBrief: "two more",
    children: [
      { title: "Endpoint D", content: "do D" },
      { title: "Endpoint E", content: "do E" },
    ],
  }) as { children: Array<{ externalKey: string | null; title: string }> };

  console.log("--- accepted append ---");
  console.log(JSON.stringify(accepted.children, null, 2));
  console.log("--- final child list ---");
  console.log(JSON.stringify(children(), null, 2));
  console.log("parent status after accept:", workspaces.promptOutcome(parent.id).status);
  console.log("parent trigger:", workspaces.latestStatusTrigger(parent.id));

  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  workspaces.remove(workspace.id);
  rmSync(dir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
