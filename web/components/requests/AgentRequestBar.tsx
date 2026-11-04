"use client";

import { useMemo, useState } from "react";
import type { AgentRequestMode, AgentRequestTarget, WorkspaceTree } from "@agent-console/shared";
import { AGENT_REQUEST_MODES, AGENT_REQUEST_MODE_LABELS, agentRequestModeBlock, allowedAgentRequestModes } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { useAgentConsole, type RunStatus } from "@/lib/useAgentConsole";
import { workspaceApi } from "@/lib/workspacesApi";
import { ConsultBriefing } from "../ConsultBriefing";
import { Button } from "../ui/Button";
import { Select, TextArea } from "../ui/Field";
import { useToast } from "../ui/Toast";
import { useProviders } from "../programs/useProviders";
import { ProviderModelPicker, useAgentChoice } from "../programs/ProviderModelPicker";

interface Props {
  serverUrl: string;
  tree: WorkspaceTree;
  /** What the request is about when it opens. It can be changed from the "About" menu. */
  initialTarget: AgentRequestTarget;
  initialMode?: AgentRequestMode;
  /** A proposal was opened: `program:<id>` or `instructions:<id>`. */
  onProposalOpened(key: string): void | Promise<void>;
}

/*
 * Targets travel through the <select> as strings:
 *   workspace · new-program · instructions:claudeMd · program:3 · program:3:suite:7 · program:3:prompt:12
 */
function encodeTarget(target: AgentRequestTarget): string {
  switch (target.kind) {
    case "workspace":
    case "new-program":
      return target.kind;
    case "instructions":
      return `instructions:${target.field}`;
    case "program":
      return target.promptId != null
        ? `program:${target.programId}:prompt:${target.promptId}`
        : target.suiteId != null
          ? `program:${target.programId}:suite:${target.suiteId}`
          : `program:${target.programId}`;
  }
}

function decodeTarget(value: string): AgentRequestTarget {
  if (value === "new-program") return { kind: "new-program" };
  if (value === "instructions:claudeMd" || value === "instructions:agentsMd") {
    return { kind: "instructions", field: value.slice("instructions:".length) as "claudeMd" | "agentsMd" };
  }
  const match = value.match(/^program:(\d+)(?::(suite|prompt):(\d+))?$/);
  if (match === null) return { kind: "workspace" };
  const programId = Number(match[1]);
  if (match[2] === "suite") return { kind: "program", programId, suiteId: Number(match[3]) };
  if (match[2] === "prompt") return { kind: "program", programId, promptId: Number(match[3]) };
  return { kind: "program", programId };
}

const label = (key: string | null, name: string) => (key === null ? name : `${key} — ${name}`);

const PLACEHOLDERS: Record<AgentRequestTarget["kind"], Partial<Record<AgentRequestMode, string>>> = {
  workspace: { ask: "e.g. Where is authentication handled? · What would break if we dropped Node 18?" },
  instructions: {
    ask: "e.g. Does this file still match how the repo is tested?",
    change: "e.g. Add a rule to run the linter before committing · Remove the section about the old deploy script.",
    edit: "What is this change for? You edit the text yourself.",
  },
  program: {
    ask: "e.g. If S2-03 stays blocked, what still runs?",
    change: "e.g. Add a lint step to every Verify block · Split S3 into smaller items.",
    edit: "What is this change for? You edit the draft yourself.",
  },
  "new-program": {
    draft: "e.g. Move the API off the legacy host, one endpoint at a time, without downtime.",
    edit: "What should the program achieve? You write the suites yourself.",
  },
};

/**
 * One place to ask an agent for anything in this workspace.
 *
 * Two choices frame every request: the target, which starts at whatever the
 * request was opened from but can be changed, and the mode, which says what
 * the agent may do. Modes that make no sense for a target are disabled with
 * the reason, using the same table the server enforces. `Ask` answers here;
 * every other mode opens a proposal, and nothing changes until it is applied.
 */
export function AgentRequestBar({ serverUrl, tree, initialTarget, initialMode = "ask", onProposalOpened }: Props) {
  const toast = useToast();
  const console_ = useAgentConsole();
  const { providers } = useProviders(serverUrl);
  const agent = useAgentChoice(providers);

  const [targetValue, setTargetValue] = useState(() => encodeTarget(initialTarget));
  const target = useMemo(() => decodeTarget(targetValue), [targetValue]);

  const [pickedMode, setMode] = useState<AgentRequestMode>(initialMode);
  const allowed = allowedAgentRequestModes(target);
  const mode = allowed.includes(pickedMode) ? pickedMode : allowed[0]!;

  const [text, setText] = useState("");
  const provider = agent.choice.provider;
  const [busy, setBusy] = useState(false);

  const [askedRunId, setAskedRunId] = useState<string | null>(null);
  const [ended, setEnded] = useState<RunStatus | null>(null);
  // Live while the socket lists the run, then its closed record — kept here the
  // moment it is seen, because `lastConsult` moves on when any other consult ends.
  const live = askedRunId === null ? undefined : console_.runs.find((run) => run.runId === askedRunId);
  const closed = askedRunId !== null && console_.lastConsult?.runId === askedRunId ? console_.lastConsult : null;
  if (closed !== null && closed !== ended) setEnded(closed);
  const answer = live ?? closed ?? (ended?.runId === askedRunId ? ended : null);

  const needsAgent = mode !== "edit";
  const cursorAsk = mode === "ask" && provider === "cursor";
  const canSend = text.trim() !== "" && !busy && (!needsAgent || (provider !== "" && !cursorAsk));

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      const result = await workspaceApi.agentRequest(serverUrl, tree.id, {
        target,
        mode,
        text: text.trim(),
        ...(needsAgent ? { provider, model: agent.choice.model } : {}),
      });
      if (result.kind === "consult") {
        setAskedRunId(result.runId);
        return;
      }
      setText("");
      const key = result.kind === "program-draft" ? `program:${result.draft.id}` : `instructions:${result.proposal.id}`;
      toast.success(
        result.runId === null ? "Proposal opened" : "The agent is writing a proposal",
        "Review it in Proposals. Nothing changes until you apply it.",
      );
      await onProposalOpened(key);
    } catch (error) {
      toast.error("Could not send the request", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  // The suite or work item the request was opened from stays in the menu.
  const selectedProgram = initialTarget.kind === "program" ? tree.programs.find((program) => program.id === initialTarget.programId) ?? null : null;
  const selectedSuite = initialTarget.kind === "program"
    ? selectedProgram?.suites.find((suite) => suite.id === initialTarget.suiteId || suite.prompts.some((prompt) => prompt.id === initialTarget.promptId)) ?? null
    : null;
  const selectedPrompt = initialTarget.kind === "program" ? selectedSuite?.prompts.find((prompt) => prompt.id === initialTarget.promptId) ?? null : null;

  return (
    <section aria-label="Ask an agent" className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="About"
          fieldClassName="min-w-[14rem] flex-1"
          value={targetValue}
          onChange={(event) => setTargetValue(event.target.value)}
        >
          <option value="workspace">This workspace</option>
          <optgroup label="Instruction files">
            <option value="instructions:claudeMd">CLAUDE.md</option>
            <option value="instructions:agentsMd">AGENTS.md</option>
          </optgroup>
          {selectedSuite !== null && selectedProgram !== null && (
            <optgroup label="Selected">
              {selectedPrompt !== null && (
                <option value={`program:${selectedProgram.id}:prompt:${selectedPrompt.id}`}>
                  Work item {label(selectedPrompt.externalKey, selectedPrompt.title)}
                </option>
              )}
              <option value={`program:${selectedProgram.id}:suite:${selectedSuite.id}`}>
                Suite {label(selectedSuite.externalKey, selectedSuite.name)}
              </option>
            </optgroup>
          )}
          <optgroup label="Programs">
            {tree.programs.map((program) => (
              <option key={program.id} value={`program:${program.id}`}>{program.name}</option>
            ))}
            <option value="new-program">+ New program</option>
          </optgroup>
        </Select>

        <div role="radiogroup" aria-label="What should the agent do" className="inline-flex h-9 rounded-md border border-line bg-surface-0 p-0.5">
          {AGENT_REQUEST_MODES.map((entry) => {
            const blocked = agentRequestModeBlock(target, entry);
            return (
              <button
                key={entry}
                type="button"
                role="radio"
                aria-checked={mode === entry}
                disabled={blocked !== null}
                title={blocked ?? AGENT_REQUEST_MODE_LABELS[entry].hint}
                onClick={() => setMode(entry)}
                className={cn(
                  "h-8 rounded px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  mode === entry ? "bg-surface-3 text-fg" : "text-fg-dim hover:text-fg",
                )}
              >
                {AGENT_REQUEST_MODE_LABELS[entry].label}
              </button>
            );
          })}
        </div>
      </div>

      <TextArea
        label="Request"
        rows={5}
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder={PLACEHOLDERS[target.kind][mode]}
        hint={AGENT_REQUEST_MODE_LABELS[mode].hint}
      />

      <div className="flex flex-wrap items-end justify-between gap-3">
        {needsAgent ? (
          <ProviderModelPicker
            providers={providers}
            state={agent}
            label="Agent and model"
            blockedReason={(id) => (mode === "ask" && id === "cursor" ? "Cursor has no read-only mode, so it cannot answer questions" : null)}
          />
        ) : (
          <span className="text-[11px] text-fg-dim">No agent runs — you write the proposal yourself.</span>
        )}
        <Button
          variant="primary"
          loading={busy}
          disabled={!canSend}
          title={cursorAsk ? "Cursor has no read-only mode, so it cannot answer questions" : "Ctrl+Enter"}
          onClick={() => void send()}
        >
          {AGENT_REQUEST_MODE_LABELS[mode].action}
        </Button>
      </div>

      {askedRunId !== null && answer === null && <p className="text-[11px] text-fg-dim">Starting the agent…</p>}
      {answer !== null && (
        <ConsultBriefing
          key={answer.runId}
          consults={live === undefined ? [] : [live]}
          lastConsult={answer}
          itemsFor={console_.itemsFor}
          workdir={tree.workDirectory}
          onStop={(runId) => console_.interrupt(runId)}
        />
      )}
    </section>
  );
}
