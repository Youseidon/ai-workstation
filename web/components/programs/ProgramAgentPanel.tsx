"use client";

import { useState } from "react";
import type { ProgramRecord, ProviderId } from "@agent-console/shared";
import { useAgentConsole, type RunStatus } from "@/lib/useAgentConsole";
import { workspaceApi } from "@/lib/workspacesApi";
import { ConsultBriefing } from "../ConsultBriefing";
import { Button } from "../ui/Button";
import { Select, TextArea } from "../ui/Field";
import { useToast } from "../ui/Toast";
import { useProviders } from "./useProviders";

interface Props {
  serverUrl: string;
  workDirectory: string;
  program: ProgramRecord;
  /**
   * What is selected inside the program, e.g. "suite S2 — Endpoints" or
   * "work item S2-03 — Port the handlers". Prefixed to the request so "this"
   * means what the operator is looking at.
   */
  focus: string | null;
  /** A revision draft was opened; the drafts panel should show it. */
  onRevisionStarted(draftId: number): void | Promise<void>;
}

/**
 * Talk to an agent about a program that already exists.
 *
 * Two doors, and the difference between them is the whole point of the panel:
 * **Ask** is read-only — the agent reads the program, its pipelines and the
 * repository and answers, and nothing can change. **Propose changes** opens a
 * revision draft the agent edits; it lands in the drafts list above, and the
 * program changes only when that draft is applied.
 *
 * The caller keys this component by program id, so selecting another program
 * starts a fresh conversation rather than showing the last program's answer.
 */
export function ProgramAgentPanel({ serverUrl, workDirectory, program, focus, onRevisionStarted }: Props) {
  const toast = useToast();
  const console_ = useAgentConsole();
  const { providers, firstAvailable } = useProviders(serverUrl);
  const [text, setText] = useState("");
  const [picked, setProvider] = useState<ProviderId | "">("");
  const provider = picked !== "" ? picked : firstAvailable;
  const [busy, setBusy] = useState<"ask" | "change" | null>(null);
  const [askedRunId, setAskedRunId] = useState<string | null>(null);
  const [ended, setEnded] = useState<RunStatus | null>(null);

  // The run this panel started: live while the socket lists it, then its closed
  // record. `lastConsult` moves on when any other consult ends, so the closed
  // record is kept here the moment it is seen.
  const live = askedRunId === null ? undefined : console_.runs.find((run) => run.runId === askedRunId);
  const closed = askedRunId !== null && console_.lastConsult?.runId === askedRunId ? console_.lastConsult : null;
  if (closed !== null && closed !== ended) setEnded(closed);
  const answer = live ?? closed ?? (ended?.runId === askedRunId ? ended : null);

  const request = () => {
    const trimmed = text.trim();
    return focus === null ? trimmed : `Regarding ${focus}:\n\n${trimmed}`;
  };

  const ask = async () => {
    if (text.trim() === "" || provider === "") return;
    setBusy("ask");
    try {
      const started = await workspaceApi.askAboutProgram(serverUrl, program.id, { question: request(), provider });
      setAskedRunId(started.runId);
    } catch (error) {
      toast.error("Could not ask", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const change = async (withAgent: boolean) => {
    if (text.trim() === "") return;
    setBusy("change");
    try {
      const started = await workspaceApi.startProgramRevision(serverUrl, program.id, {
        goal: request(),
        ...(withAgent && provider !== "" ? { provider } : {}),
      });
      toast.success(
        withAgent ? "The agent is drafting the changes" : "Revision draft opened",
        "It is in the drafts list above. Nothing in the program changes until you apply it.",
      );
      setText("");
      await onRevisionStarted(started.draft.id);
    } catch (error) {
      toast.error("Could not start the revision", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const noText = text.trim() === "";

  return (
    <section className="space-y-3 rounded-panel border border-line bg-surface-1 p-4">
      <div>
        <h3 className="text-[13px] font-medium text-fg">Ask an agent about “{program.name}”</h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-fg-dim">
          The agent reads every suite and work item, their dependencies and checks, the pipelines that run them, and the repository.
          Ask what will happen, or ask for changes — changes arrive as a draft you review before anything is modified.
        </p>
      </div>
      <TextArea
        label={focus === null ? "Question or change" : `Question or change, regarding ${focus}`}
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="e.g. If S2-03 stays blocked, what still runs? · Add a lint step to every Verify block · Split S3 into smaller items."
      />
      <div className="flex flex-wrap items-end gap-2">
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
        <Button
          variant="secondary"
          loading={busy === "ask"}
          disabled={busy !== null || noText || provider === "" || provider === "cursor"}
          title={provider === "cursor" ? "Cursor has no read-only mode, so it cannot answer questions" : "Read-only: nothing is changed"}
          onClick={() => void ask()}
        >
          Ask
        </Button>
        <Button
          variant="primary"
          loading={busy === "change"}
          disabled={busy !== null || noText || provider === ""}
          title="Opens a revision draft for the agent to edit; you apply it"
          onClick={() => void change(true)}
        >
          Propose changes
        </Button>
        <Button
          variant="ghost"
          disabled={busy !== null || noText}
          title="Open a revision draft to edit by hand, without an agent"
          onClick={() => void change(false)}
        >
          Edit as a draft myself
        </Button>
      </div>
      {askedRunId !== null && answer === null && (
        <p className="text-[11px] text-fg-dim">Starting the agent…</p>
      )}
      {answer !== null && (
        <ConsultBriefing
          key={answer.runId}
          consults={live === undefined ? [] : [live]}
          lastConsult={answer}
          itemsFor={console_.itemsFor}
          workdir={workDirectory}
          onStop={(runId) => console_.interrupt(runId)}
        />
      )}
    </section>
  );
}
