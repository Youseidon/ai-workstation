"use client";

import { useState } from "react";
import type { WorkspaceRecord } from "@agent-console/shared";
import { Button } from "../ui/Button";
import { TextArea, TextInput } from "../ui/Field";
import { Modal } from "../ui/Modal";

export type WorkspaceDraft = { name: string; workDirectory: string; description: string };

interface Props {
  open: boolean;
  /** The workspace being configured, or null to create one. */
  workspace: WorkspaceRecord | null;
  busy: boolean;
  onClose(): void;
  onSubmit(draft: WorkspaceDraft): void;
  onDelete?(): void;
}

/**
 * Creating a workspace and configuring one are the same three fields, so they
 * share a form. Mount it with a `key` per workspace so the draft resets.
 */
export function WorkspaceSettingsModal({ open, workspace, busy, onClose, onSubmit, onDelete }: Props) {
  const creating = workspace === null;
  const [draft, setDraft] = useState<WorkspaceDraft>({
    name: workspace?.name ?? "",
    workDirectory: workspace?.workDirectory ?? "",
    description: workspace?.description ?? "",
  });
  const [touched, setTouched] = useState(false);
  const nameError = touched && draft.name.trim() === "" ? "A name is required." : null;
  const pathError =
    touched && !draft.workDirectory.trim().startsWith("/")
      ? "Use an absolute path, starting with /."
      : !creating && draft.workDirectory === workspace.workDirectory && !workspace.workDirectoryExists
        ? "This directory does not exist on disk."
        : null;
  const dirty =
    creating ||
    draft.name !== workspace.name ||
    draft.workDirectory !== workspace.workDirectory ||
    draft.description !== workspace.description;

  const submit = () => {
    setTouched(true);
    if (draft.name.trim() === "" || !draft.workDirectory.trim().startsWith("/")) return;
    onSubmit({ ...draft, name: draft.name.trim(), workDirectory: draft.workDirectory.trim() });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={creating ? "New workspace" : "Workspace settings"}
      description={
        creating
          ? "Point a workspace at your project. Agents read and write inside that directory."
          : "Where agents work, and what they are always told."
      }
      footer={
        <>
          {!creating && onDelete !== undefined && (
            <Button variant="ghost" className="mr-auto text-danger! hover:bg-danger/10" onClick={onDelete}>
              Delete workspace
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={submit}>
            {creating ? "Create workspace" : "Save"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextInput
          label="Name"
          required
          value={draft.name}
          error={nameError}
          placeholder="my-project"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <TextInput
          label="Project directory"
          required
          className="font-mono"
          value={draft.workDirectory}
          error={pathError}
          hint="Absolute path to the project agents should work on."
          placeholder="/home/you/projects/my-project"
          onChange={(event) => setDraft({ ...draft, workDirectory: event.target.value })}
        />
        <TextArea
          label="Standing instructions"
          rows={4}
          value={draft.description}
          hint="Optional. Given to every work-item run in this workspace."
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
        {/* Lets Enter in a single-line field submit. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
