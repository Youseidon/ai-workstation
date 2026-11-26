"use client";

import type { AgentRequestMode, AgentRequestTarget, WorkspaceTree } from "@hydra/shared";
import { AgentRequestBar } from "../../requests/components/AgentRequestBar";
import { Modal } from "../../../components/ui/Modal";
import { SparkIcon } from "./shared";

interface Props {
  serverUrl: string;
  tree: WorkspaceTree;
  target: AgentRequestTarget;
  mode?: AgentRequestMode;
  onClose(): void;
  onProposalOpened(key: string): void;
  onCreateEmptyProgram?(): void;
}

export function AgentRequestModal({ serverUrl, tree, target, mode, onClose, onProposalOpened, onCreateEmptyProgram }: Props) {
  const newProgram = target.kind === "new-program";
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <SparkIcon className="size-4 text-accent" />
          {newProgram ? "New program" : "Ask an agent"}
        </span>
      }
      description={
        newProgram
          ? "Describe the outcome. An agent reads the project and drafts suites and work items for you to review before anything is created."
          : "Ask a question, or ask for changes. Changes arrive as a proposal you review and apply."
      }
    >
      <AgentRequestBar
        serverUrl={serverUrl}
        tree={tree}
        initialTarget={target}
        initialMode={mode ?? (newProgram ? "draft" : undefined)}
        onProposalOpened={onProposalOpened}
      />
      {newProgram && onCreateEmptyProgram !== undefined && (
        <p className="mt-4 border-t border-line pt-3 text-xs text-fg-dim">
          Already know the structure?{" "}
          <button type="button" className="text-accent hover:underline" onClick={onCreateEmptyProgram}>
            Create an empty program
          </button>{" "}
          and add suites yourself.
        </p>
      )}
    </Modal>
  );
}
