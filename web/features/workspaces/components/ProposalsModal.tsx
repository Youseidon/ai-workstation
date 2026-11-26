"use client";

import { useCallback, useEffect, useState } from "react";
import type { InstructionProposalRecord, ProgramDraftRecord } from "@hydra/shared";
import { useHydra } from "@/hooks/useHydra";
import { workspaceApi } from "@/api/workspacesApi";
import { ProgramDraftPanel } from "../../programs/components/ProgramDraftPanel";
import { Modal } from "../../../components/ui/Modal";
import { InboxIcon } from "./shared";

interface Props {
  serverUrl: string;
  workspaceId: number;
  instructions: { claudeMd: string; agentsMd: string };
  openKey: string | null;
  onApplied(): void | Promise<void>;
  onClose(): void;
}

export function ProposalsModal({ serverUrl, workspaceId, instructions, openKey, onApplied, onClose }: Props) {
  return (
    <Modal
      open
      size="2xl"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <InboxIcon className="size-4 text-accent" />
          Proposals
        </span>
      }
      description="New programs, program changes and instruction-file edits written by an agent or by you. Nothing changes until you apply it."
      bodyClassName="p-0"
    >
      <ProgramDraftPanel
        serverUrl={serverUrl}
        workspaceId={workspaceId}
        instructions={instructions}
        onApplied={onApplied}
        initialOpenKey={openKey}
      />
    </Modal>
  );
}

export interface ProposalSummary {
  pending: number;
  byField: { claudeMd: number; agentsMd: number };
  byProgram: Map<number, number>;
  newPrograms: number;
}

const EMPTY: ProposalSummary = { pending: 0, byField: { claudeMd: 0, agentsMd: 0 }, byProgram: new Map(), newPrograms: 0 };

function summarize(drafts: ProgramDraftRecord[], proposals: InstructionProposalRecord[]): ProposalSummary {
  const summary: ProposalSummary = { pending: 0, byField: { claudeMd: 0, agentsMd: 0 }, byProgram: new Map(), newPrograms: 0 };
  for (const proposal of proposals) {
    if (proposal.state !== "PENDING") continue;
    summary.pending += 1;
    summary.byField[proposal.field] += 1;
  }
  for (const draft of drafts) {
    if (draft.state !== "PENDING") continue;
    summary.pending += 1;
    if (draft.targetProgramId === null) summary.newPrograms += 1;
    else summary.byProgram.set(draft.targetProgramId, (summary.byProgram.get(draft.targetProgramId) ?? 0) + 1);
  }
  return summary;
}

export function useProposalSummary(serverUrl: string, workspaceId: number | null) {
  const console_ = useHydra();
  const [summary, setSummary] = useState<ProposalSummary>(EMPTY);

  const reload = useCallback(async () => {
    if (workspaceId === null) {
      setSummary(EMPTY);
      return;
    }
    try {
      const [drafts, proposals] = await Promise.all([
        workspaceApi.programDrafts(serverUrl, workspaceId),
        workspaceApi.instructionProposals(serverUrl, workspaceId),
      ]);
      setSummary(summarize(drafts.map((entry) => entry.draft), proposals));
    } catch {
    }
  }, [serverUrl, workspaceId]);

  const liveRuns = console_.runs.map((run) => run.runId).join(",");
  useEffect(() => {
    const timer = setTimeout(() => { void reload(); }, 300);
    return () => clearTimeout(timer);
  }, [liveRuns, reload]);

  return { summary, reload };
}
