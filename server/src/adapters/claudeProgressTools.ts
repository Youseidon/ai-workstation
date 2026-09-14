import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentProgressTools } from "./types.ts";

/*
 * Claude runs in-process, so instead of telling it to `curl` the local
 * Progress API (which a non-bypass permission mode refuses) the run gets typed
 * tools bound to its own credential. The handlers enforce every rule; these
 * schemas only give the model a precise contract.
 */

export const CLAUDE_PROGRESS_SERVER_NAME = "agent-console";

const REQUEST_ID = z
  .string()
  .regex(/^[-0-9a-zA-Z]{8,100}$/)
  .describe("8-100 letters, digits or hyphens, unique for this run; a retry with the same id returns the recorded result.");

const REMARK_KINDS = ["PROGRESS", "FINDING", "DECISION_NEEDED", "BLOCKER", "VERIFICATION", "COMPLETION"] as const;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

/** Refusals reach the model as readable tool errors with the same code the HTTP API returns. */
function refused(error: unknown): ToolResult {
  const code = error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "tool_failed";
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

async function guarded(action: () => unknown): Promise<ToolResult> {
  try {
    return ok(action());
  } catch (error) {
    return refused(error);
  }
}

export function claudeProgressToolDefinitions(tools: AgentProgressTools) {
  return [
    tool(
      "get_context",
      "Returns this run's authoritative work item context: the task, its dependencies, remark history and human answers. Call it before doing anything else.",
      {},
      async () => guarded(() => tools.getContext()),
    ),
    tool(
      "post_remark",
      "Records a remark on this run's work item.",
      {
        requestId: REQUEST_ID,
        kind: z.enum(REMARK_KINDS),
        content: z.string().min(1).max(20000),
      },
      async (args) => guarded(() => tools.postRemark(args)),
    ),
    tool(
      "post_status",
      "Records this run's single terminal status: DONE with a verification summary, or BLOCKED with evidence and the exact human action required.",
      {
        requestId: REQUEST_ID,
        expectedStatus: z.literal("IN_PROGRESS"),
        status: z.enum(["DONE", "BLOCKED"]),
        reason: z.string().max(10000).describe("For BLOCKED: observed evidence showing why execution cannot continue."),
        verificationSummary: z.string().max(20000).describe("For DONE: commands run and observable results. For BLOCKED: the exact action only the human can take."),
      },
      async (args) => guarded(() => tools.postStatus(args)),
    ),
  ];
}

export function claudeProgressMcpServer(tools: AgentProgressTools): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: CLAUDE_PROGRESS_SERVER_NAME, version: "1.0.0", tools: claudeProgressToolDefinitions(tools) });
}
