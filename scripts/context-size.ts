/**
 * Measure the execute-context markdown an agent would receive for one work item.
 *
 * Usage:
 *   AGENT_CONSOLE_DB=/tmp/copy.sqlite node --import tsx scripts/context-size.ts --db /tmp/copy.sqlite --prompt 133
 *
 * Always point --db at a *copy* of the live database. This script only reads,
 * but the server module it loads is the same one that can write.
 */
import { copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const dbArg = arg("db");
const promptArg = arg("prompt");
if (dbArg === undefined || promptArg === undefined) {
  process.stderr.write("Usage: node --import tsx scripts/context-size.ts --db <path> --prompt <id>\n");
  process.exit(1);
}
if (!existsSync(dbArg)) {
  process.stderr.write(`Database not found: ${dbArg}\n`);
  process.exit(1);
}

const promptId = Number(promptArg);
if (!Number.isInteger(promptId) || promptId <= 0) {
  process.stderr.write(`--prompt must be a positive integer, got ${promptArg}\n`);
  process.exit(1);
}

// Work against an ephemeral copy so a mistaken write cannot touch the file the
// caller handed us (often itself already a copy of the live DB).
const scratch = join(tmpdir(), `context-size-${process.pid}-${Date.now()}.sqlite`);
copyFileSync(dbArg, scratch);
process.env.AGENT_CONSOLE_DB = scratch;

function sectionBytes(markdown: string): Array<{ title: string; bytes: number }> {
  const rows: Array<{ title: string; bytes: number }> = [];
  const re = /^## .+$/gm;
  const starts: Array<{ title: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    starts.push({ title: match[0].replace(/^##\s+/, "").trim(), index: match.index });
  }
  const preamble = starts.length === 0 ? markdown : markdown.slice(0, starts[0]!.index);
  if (preamble.trim() !== "") rows.push({ title: "(title / preamble)", bytes: Buffer.byteLength(preamble) });
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]!.index;
    const to = i + 1 < starts.length ? starts[i + 1]!.index : markdown.length;
    rows.push({ title: starts[i]!.title, bytes: Buffer.byteLength(markdown.slice(from, to)) });
  }
  return rows;
}

async function main(): Promise<void> {
  const { workspaces, DECOMPOSE_MAX_DEPTH } = await import("../server/src/workspaces.ts");
  const { contextMarkdown, progressApiMarkdown, budgetMarkdown } = await import("../server/src/agentContext.ts");

  // Resolve the workspace from the prompt itself — a DB can hold several.
  const listed = workspaces.list();
  let context = null as ReturnType<typeof workspaces.agentContext> | null;
  let lastError: unknown;
  for (const workspace of listed) {
    try {
      context = workspaces.agentContext(workspace.id, promptId);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (context === null) throw lastError ?? new Error(`Prompt ${promptId} not found in any workspace`);
  const depth = workspaces.decomposeDepth(promptId);
  const body = contextMarkdown(context, "execute", { depth, maxDepth: DECOMPOSE_MAX_DEPTH });
  const api = progressApiMarkdown({
    runId: "measure",
    token: "measure",
    port: 4000,
    canDecompose: depth < DECOMPOSE_MAX_DEPTH,
    shimPath: "/tmp/measure/agent-step",
  });
  const markdown = `${body}\n\n${api}${budgetMarkdown(null)}`;
  const total = Buffer.byteLength(markdown);

  process.stdout.write(`prompt ${promptId} (${context.prompt.externalKey ?? context.prompt.title}) — ${total} bytes\n`);
  process.stdout.write(`${"bytes".padStart(7)}  section\n`);
  process.stdout.write(`${"-".repeat(7)}  ${"-".repeat(40)}\n`);
  for (const row of sectionBytes(markdown)) {
    process.stdout.write(`${String(row.bytes).padStart(7)}  ${row.title}\n`);
  }
  process.stdout.write(`${"-".repeat(7)}\n`);
  process.stdout.write(`${String(total).padStart(7)}  TOTAL\n`);

  workspaces.close();
}

void main();
