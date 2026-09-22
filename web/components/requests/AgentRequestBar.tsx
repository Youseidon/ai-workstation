"use client";

import { useMemo, useState } from "react";
import type { AgentRequestMode, AgentRequestTarget, ProviderId, WorkspaceTree } from "@agent-console/shared";
import { AGENT_REQUEST_MODES, AGENT_REQUEST_MODE_LABELS, agentRequestModeBlock, allowedAgentRequestModes } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { useAgentConsole, type RunStatus } from "@/lib/useAgentConsole";
import { workspaceApi } from "@/lib/workspacesApi";
import { ConsultBriefing } from "../ConsultBriefing";
import { Button } from "../ui/Button";
import { Select, TextArea } from "../ui/Field";
import { useToast } from "../ui/Toast";
import { useProviders } from "../programs/useProviders";

/** What is selected in the directory tree, which the target follows. */
export interface TreeSelection {
  instructionField: "claudeMd" | "agentsMd" | null;
  programId: number | null;
  suiteId: number | null;
  promptId: number | null;
}

interface Props {
  serverUrl: string;
  tree: WorkspaceTree;
  selection: TreeSelection;
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

function targetFromSelection(selection: TreeSelection): AgentRequestTarget {
  if (selection.instructionField !== null) return { kind: "instructions", field: selection.instructionField };
  if (selection.programId !== null) {
    return { kind: "program", programId: selection.programId, suiteId: selection.suiteId, promptId: selection.promptId };
  }
  return { kind: "workspace" };
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
 * Two choices frame every request: the target, which follows whatever is
 * selected in the tree but can be changed, and the mode, which says what the
 * agent may do. Modes that make no sense for a target are disabled with the
 * reason, using the same table the server enforces. `Ask` answers here; every
 * other mode opens a proposal in the list below, and nothing changes until it
 * is applied.
 */
export function AgentRequestBar({ serverUrl, tree, selection, onProposalOpened }: Props) {
  const toast = useToast();
  const console_ = useAgentConsole();
  const { providers, firstAvailable } = useProviders(serverUrl);

  const selected = encodeTarget(targetFromSelection(selection));
  const [targetValue, setTargetValue] = useState(selected);
  // A new tree selection re-points the target; picking another target by hand
  // holds until the selection moves again.
  const [followed, setFollowed] = useState(selected);
  if (followed !== selected) {
    setFollowed(selected);
    setTargetValue(selected);
  }
  const target = useMemo(() => decodeTarget(targetValue), [targetValue]);

  const [pickedMode, setMode] = useState<AgentRequestMode>("ask");
  const allowed = allowedAgentRequestModes(target);
  const mode = allowed.includes(pickedMode) ? pickedMode : allowed[0]!;

  const [text, setText] = useState("");
  const [picked, setProvider] = useState<ProviderId | "">("");
  const provider = picked !== "" ? picked : firstAvailable;
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
        ...(needsAgent ? { provider } : {}),
      });
      if (result.kind === "consult") {
        setAskedRunId(result.runId);
        return;
      }
      setText("");
      const key = result.kind === "program-draft" ? `program:${result.draft.id}` : `instructions:${result.proposal.id}`;
      toast.success(
        result.runId === null ? "Proposal opened" : "The agent is writing a proposal",
        "It is in the proposals list below. Nothing changes until you apply it.",
      );
      await onProposalOpened(key);
    } catch (error) {
      toast.error("Could not send the request", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const selectedProgram = selection.programId === null ? null : tree.programs.find((program) => program.id === selection.programId) ?? null;
  const selectedSuite = selectedProgram?.suites.find((suite) => suite.id === selection.suiteId) ?? null;
  const selectedPrompt = selectedSuite?.prompts.find((prompt) => prompt.id === selection.promptId) ?? null;

  return (
    <section aria-label="Ask an agent" className="space-y-3 rounded-panel border border-line bg-surface-1 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="About"
          fieldClassName="min-w-[14rem] flex-1 sm:max-w-sm"
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

        <div role="radiogroup" aria-label="What should the agent do" className="inline-flex rounded-md border border-line bg-surface-0 p-0.5">
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
        rows={3}
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

      <div className="flex flex-wrap items-end justify-end gap-2">
        {needsAgent && (
          <Select
            label="Agent"
            fieldClassName="w-44"
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderId | "")}
          >
            {providers.length === 0 && <option value="">no provider detected</option>}
            {providers.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={!entry.available}>
                {entry.id}{entry.available ? "" : " — unavailable"}
              </option>
            ))}
          </Select>
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
