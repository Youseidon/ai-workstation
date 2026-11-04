"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { INSTRUCTION_FILE_NAMES } from "@agent-console/shared";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useDialogs } from "../ui/Dialogs";
import { Segmented, SparkIcon, formatDate } from "./shared";

export type InstructionField = "claudeMd" | "agentsMd";

export const INSTRUCTION_HINTS: Record<InstructionField, string> = {
  claudeMd: "Read by Claude Code.",
  agentsMd: "Read by Codex, Cursor and Grok.",
};

interface Props {
  field: InstructionField;
  value: string;
  updatedAt: string;
  busy: boolean;
  /** Pending proposals against this file. */
  pendingProposals: number;
  onClose(): void;
  onSave(content: string): Promise<boolean>;
  onPropose(): void;
  onReviewProposals(): void;
}

/** One instruction file, read rendered and edited as source. */
export function InstructionFileModal({ field, value, updatedAt, busy, pendingProposals, onClose, onSave, onPropose, onReviewProposals }: Props) {
  const dialogs = useDialogs();
  const name = INSTRUCTION_FILE_NAMES[field];
  const [draft, setDraft] = useState(value);
  const [mode, setMode] = useState<"view" | "edit">(value.trim() === "" ? "edit" : "view");
  const dirty = draft !== value;

  /** Leaving with unsaved text asks first; everything else just closes. */
  const leave = async (then: () => void) => {
    if (dirty) {
      const confirmed = await dialogs.confirm({
        title: "Discard unsaved changes?",
        description: `Your edits to ${name} have not been saved.`,
        confirmLabel: "Discard",
        tone: "danger",
      });
      if (!confirmed) return;
    }
    then();
  };

  return (
    <Modal
      open
      size="xl"
      onClose={() => void leave(onClose)}
      title={name}
      description={`${INSTRUCTION_HINTS[field]} Written to the project root before each run · updated ${formatDate(updatedAt)}`}
      bodyClassName="p-0"
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            iconLeft={<SparkIcon className="size-4 text-accent" />}
            onClick={() => void leave(onPropose)}
          >
            Propose changes with AI
          </Button>
          {dirty && <span className="text-[11px] text-warning">Unsaved changes</span>}
          {mode === "view" ? (
            <Button variant="primary" onClick={() => setMode("edit")}>Edit</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => { setDraft(value); setMode("view"); }}>
                {dirty ? "Revert" : "Cancel"}
              </Button>
              <Button
                variant="primary"
                loading={busy}
                disabled={!dirty}
                onClick={async () => {
                  if (await onSave(draft)) setMode("view");
                }}
              >
                Save
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5">
        <Segmented<"view" | "edit">
          label="Document mode"
          value={mode}
          onChange={setMode}
          options={[{ value: "view", label: "Preview" }, { value: "edit", label: "Source" }]}
        />
        {pendingProposals > 0 && (
          <button type="button" onClick={() => void leave(onReviewProposals)} className="flex items-center gap-2 text-[11px] text-fg-muted hover:text-fg">
            <Badge tone="info">{pendingProposals} pending</Badge>
            Review proposal{pendingProposals === 1 ? "" : "s"} →
          </button>
        )}
      </div>
      {mode === "view" ? (
        <article className="prompt-document max-h-[62vh] min-h-[20rem] overflow-y-auto px-6 py-6 sm:px-10">
          {draft.trim() === "" ? (
            <p className="text-sm italic text-fg-dim">Nothing written yet. Switch to Source to write it, or propose it with AI.</p>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
          )}
        </article>
      ) : (
        <textarea
          aria-label={`${name} source`}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (dirty) void onSave(draft);
            }
          }}
          placeholder={`# ${name}\n\nHow to build, test and work in this repository…`}
          className="block h-[62vh] min-h-[20rem] w-full resize-none bg-surface-0/40 px-6 py-5 font-terminal text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-fg-dim sm:px-10"
        />
      )}
    </Modal>
  );
}
