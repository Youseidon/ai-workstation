"use client";

import { useMemo, useState } from "react";
import type { DiffLine, InstructionProposalRecord, ProviderId, ProviderInfo } from "@agent-console/shared";
import { INSTRUCTION_FILE_NAMES, diffLineCounts, diffLines } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { Button } from "../ui/Button";
import { Select, TextArea, TextInput } from "../ui/Field";

interface Props {
  proposal: InstructionProposalRecord;
  /** The file's stored text right now, to tell whether the proposal is stale. */
  current: string;
  /** An agent is writing this proposal at the moment. */
  writing: boolean;
  providers: ProviderInfo[];
  busy: boolean;
  onSave(content: string): Promise<boolean>;
  onApply(force: boolean): Promise<void>;
  onRework(feedback: string, provider: ProviderId): Promise<boolean>;
  onDiscard(): Promise<void>;
  onDelete(): Promise<void>;
}

/** Unchanged lines kept around each change; longer unchanged runs fold. */
const CONTEXT = 3;

type Hunk = { kind: "lines"; lines: DiffLine[] } | { kind: "fold"; lines: DiffLine[] };

function hunks(lines: DiffLine[]): Hunk[] {
  const near = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let at = Math.max(0, index - CONTEXT); at <= Math.min(lines.length - 1, index + CONTEXT); at += 1) near[at] = true;
  });
  const out: Hunk[] = [];
  lines.forEach((line, index) => {
    const kind = near[index] ? "lines" : "fold";
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === kind) last.lines.push(line);
    else out.push({ kind, lines: [line] });
  });
  return out;
}

/**
 * A proposed CLAUDE.md or AGENTS.md, read as a diff and applied by hand.
 *
 * The diff is recomputed from the text on screen, so an edit in the Edit tab
 * shows up in Changes before it is saved. Apply refuses a proposal whose
 * baseline is no longer the stored file; the button then says so, and forcing
 * it is a separate, explicit choice.
 */
export function InstructionProposalEditor({ proposal, current, writing, providers, busy, onSave, onApply, onRework, onDiscard, onDelete }: Props) {
  const name = INSTRUCTION_FILE_NAMES[proposal.field];
  const [content, setContent] = useState(proposal.content);
  const [tab, setTab] = useState<"changes" | "edit">("changes");
  const [openFolds, setOpenFolds] = useState<Set<number>>(() => new Set());
  const [feedback, setFeedback] = useState("");
  const [reworkProvider, setReworkProvider] = useState<ProviderId | "">(providers.find((provider) => provider.available)?.id ?? "");

  const lines = useMemo(() => diffLines(proposal.baseline, content), [proposal.baseline, content]);
  const counts = diffLineCounts(lines);
  const pending = proposal.state === "PENDING";
  const editable = pending && !writing;
  const dirty = content !== proposal.content;
  const stale = current !== proposal.baseline;
  const unchanged = counts.added === 0 && counts.removed === 0;

  return (
    <div className="space-y-3 border-t border-line bg-surface-0/40 px-4 py-4">
      <div className="space-y-1 text-[11px] leading-relaxed text-fg-dim">
        {proposal.goal !== "" && <p><span className="text-fg-muted">Asked for:</span> {proposal.goal}</p>}
        {proposal.origin === "run" && (
          <p>
            A run edited {name} in the working tree{proposal.runId === null ? "" : ` (${proposal.runId})`}. The edit was held here instead of
            being used, and the stored file was put back.
          </p>
        )}
        {writing && <p className="text-info">An agent is editing this proposal. It updates when the run ends.</p>}
        {pending && stale && (
          <p className="text-warning">
            {name} has changed since this proposal was opened. The diff below is against the older text, so applying it would undo that change.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-line bg-surface-0 p-0.5" role="tablist">
          {(["changes", "edit"] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              disabled={entry === "edit" && !editable}
              onClick={() => setTab(entry)}
              className={cn(
                "h-7 rounded px-3 text-xs transition-colors disabled:opacity-40",
                tab === entry ? "bg-surface-3 text-fg" : "text-fg-dim hover:text-fg",
              )}
            >
              {entry === "changes" ? "Changes" : "Edit"}
            </button>
          ))}
        </div>
        <span className="text-[11px] tabular-nums">
          <span className="text-success">+{counts.added}</span> <span className="text-danger">−{counts.removed}</span>
        </span>
      </div>

      {tab === "edit" && editable ? (
        <TextArea label={name} rows={18} className="font-terminal" value={content} onChange={(event) => setContent(event.target.value)} />
      ) : unchanged ? (
        <p className="rounded-md border border-dashed border-line p-4 text-xs text-fg-dim">
          {writing ? "Nothing proposed yet." : `No changes to ${name}.`}
        </p>
      ) : (
        <div className="max-h-[32rem] overflow-auto rounded-md border border-line bg-surface-0 py-1 font-terminal text-[12px] leading-5">
          {hunks(lines).map((hunk, index) =>
            hunk.kind === "fold" && !openFolds.has(index) ? (
              <button
                key={index}
                type="button"
                onClick={() => setOpenFolds((open) => new Set(open).add(index))}
                className="block w-full px-3 py-0.5 text-left text-[11px] text-fg-dim hover:bg-surface-2"
              >
                ⋯ {hunk.lines.length} unchanged line{hunk.lines.length === 1 ? "" : "s"}
              </button>
            ) : (
              hunk.lines.map((line, at) => (
                <div
                  key={`${index}:${at}`}
                  className={cn(
                    "whitespace-pre-wrap break-words px-3",
                    line.kind === "added" && "bg-success/10 text-success",
                    line.kind === "removed" && "bg-danger/10 text-danger",
                    line.kind === "same" && "text-fg-muted",
                  )}
                >
                  <span aria-hidden className="mr-2 inline-block w-3 select-none text-fg-dim">
                    {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                  </span>
                  {line.text === "" ? " " : line.text}
                </div>
              ))
            ),
          )}
        </div>
      )}

      {editable && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={stale ? "danger" : "primary"}
              disabled={busy || dirty || unchanged}
              title={dirty ? "Save your edits first" : unchanged ? "There is nothing to apply" : undefined}
              onClick={() => void onApply(stale)}
            >
              {stale ? `Apply anyway` : `Apply to ${name}`}
            </Button>
            <Button variant="secondary" loading={busy && dirty} disabled={busy || !dirty} onClick={() => void onSave(content)}>
              Save edits
            </Button>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onDiscard()}>Discard</Button>
          </div>
          <div className={cn("flex flex-wrap items-end gap-2 border-t border-line pt-3", providers.length === 0 && "opacity-60")}>
            <TextInput
              label="Ask the agent to rework it"
              fieldClassName="min-w-[16rem] flex-1"
              value={feedback}
              placeholder="e.g. Shorter. Keep the testing section as it was."
              onChange={(event) => setFeedback(event.target.value)}
            />
            <Select fieldClassName="w-40" value={reworkProvider} onChange={(event) => setReworkProvider(event.target.value as ProviderId)}>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={!provider.available}>{provider.id}</option>
              ))}
            </Select>
            <Button
              variant="secondary"
              disabled={busy || dirty || reworkProvider === "" || feedback.trim() === ""}
              title={dirty ? "Save your edits first; the agent starts from the saved text" : undefined}
              onClick={async () => {
                if (await onRework(feedback.trim(), reworkProvider as ProviderId)) setFeedback("");
              }}
            >
              Rework
            </Button>
          </div>
        </>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-fg-dim">
          Proposal {proposal.id} · updated {new Date(proposal.updatedAt).toLocaleString()}
        </p>
        {!writing && <Button size="sm" variant="danger" disabled={busy} onClick={() => void onDelete()}>Delete</Button>}
      </div>
    </div>
  );
}
