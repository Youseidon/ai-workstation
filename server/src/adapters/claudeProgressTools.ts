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

/** One choice offered with a BLOCKED status (L3 A2): the phone shows the trade-offs the agent weighed. */
const OPTION = z.object({
  label: z.string().min(1).max(20000).describe("What this choice is, in a few words."),
  advantages: z.array(z.string().max(20000)).max(10).optional().describe("Why this choice is good; one short sentence each."),
  disadvantages: z.array(z.string().max(20000)).max(10).optional().describe("What it costs or risks; one short sentence each."),
});

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
    return ok(await action());
  } catch (error) {
    return refused(error);
  }
}

export function claudeProgressToolDefinitions(tools: AgentProgressTools) {
  return [
    tool(
      "get_context",
      "Returns this run's authoritative work item context: the task, its dependencies, remark history and human answers. Call it before doing anything else.",
      {
        full: z.boolean().optional().describe("true returns the whole context: every remark and clarification, and no section cut short. Ask for it when a section says it was truncated."),
      },
      async (args) => guarded(() => tools.getContext(args)),
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
      "Records how this run ends: DONE with a verification summary, CONTINUE with what remains, or BLOCKED with evidence and the exact human action required. A DONE whose Verify commands fail is refused with their output and records nothing, so another status can still be posted.",
      {
        requestId: REQUEST_ID,
        expectedStatus: z.literal("IN_PROGRESS"),
        status: z.enum(["DONE", "CONTINUE", "BLOCKED"]),
        reason: z.string().max(10000).describe("For CONTINUE: the remaining work, as concrete instructions for the run that resumes this item. For BLOCKED: observed evidence showing why execution cannot continue."),
        verificationSummary: z.string().max(20000).describe("For DONE: commands run and observable results. For CONTINUE: what this run verified, if anything. For BLOCKED: the exact action only the human can take."),
        options: z
          .array(OPTION)
          .max(20)
          .optional()
          .describe("BLOCKED only: the choices you considered, so the human can decide from the question card. Only trade-offs you actually weighed; leave it out if there are none."),
      },
      async (args) => guarded(() => tools.postStatus(args)),
    ),
    tool(
      "repair_verify",
      "Replaces a Verify command that is itself wrong, after a refused DONE showed it failing, then runs the Verify commands again and returns what still fails.",
      {
        requestId: REQUEST_ID,
        oldCommand: z.string().min(1).describe("The failing command, exactly as the refusal printed it."),
        newCommand: z.string().min(1).describe("The corrected command."),
        reason: z.string().min(1).max(2000).describe("Why the command itself is wrong, as opposed to the work."),
      },
      async (args) => guarded(() => tools.repairVerify(args)),
    ),
    tool(
      "decompose",
      "Splits this work item's remaining work into 2-12 sub-steps that run one by one, each verified on its own. This run then ends and the item resumes when its sub-steps are finished. Refused on a sub-step that is already at the maximum depth.",
      {
        requestId: REQUEST_ID,
        resumeBrief: z.string().min(1).max(20000).describe("What this run already finished and verified, and what this item still has to do once its sub-steps are done."),
        children: z
          .array(z.object({
            title: z.string().min(1).max(200).describe("A short title, different from every existing sub-step's."),
            content: z.string().min(1).max(20000).describe("The sub-step's complete instructions. It is read on its own, so name files and expected results, and end with a `## Verify` section holding the commands that prove it."),
          }))
          .min(2)
          .max(12)
          .describe("Mostly independent slices that can each be verified separately, in the order they should run."),
      },
      async (args) => guarded(() => tools.decompose(args)),
    ),
  ];
}

export function claudeProgressMcpServer(tools: AgentProgressTools): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: CLAUDE_PROGRESS_SERVER_NAME, version: "1.0.0", tools: claudeProgressToolDefinitions(tools) });
}
