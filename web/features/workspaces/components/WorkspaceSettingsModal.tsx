"use client";

import { useState } from "react";
import type { WorkspaceRecord } from "@hydra/shared";
import { Button } from "../../../components/ui/Button";
import { TextArea, TextInput } from "../../../components/ui/Field";
import { Modal } from "../../../components/ui/Modal";
import { DirectoryPicker } from "./DirectoryPicker";

export type WorkspaceDraft = { name: string; workDirectory: string; description: string };

interface Props {
  serverUrl: string;
  open: boolean;
  workspace: WorkspaceRecord | null;
  busy: boolean;
  onClose(): void;
  onSubmit(draft: WorkspaceDraft): void;
  onDelete?(): void;
}

export function WorkspaceSettingsModal({ serverUrl, open, workspace, busy, onClose, onSubmit, onDelete }: Props) {
  const creating = workspace === null;
  const [draft, setDraft] = useState<WorkspaceDraft>({
    name: workspace?.name ?? "",
    workDirectory: workspace?.workDirectory ?? "",
    description: workspace?.description ?? "",
  });
  const [touched, setTouched] = useState(false);
  // Open by default when creating: picking a folder is the usual first step.
  const [browsing, setBrowsing] = useState(creating);
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
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <TextInput
              label="Project directory"
              required
              fieldClassName="flex-1"
              className="font-mono"
              value={draft.workDirectory}
              error={pathError}
              hint="Absolute path on the machine running Hydra. Browse, or type it."
              placeholder="/home/you/projects/my-project"
              onChange={(event) => setDraft({ ...draft, workDirectory: event.target.value })}
            />
            {!browsing && (
              <Button variant="secondary" className="mt-[1.375rem]" onClick={() => setBrowsing(true)}>
                Browse…
              </Button>
            )}
          </div>
          {browsing && (
            <DirectoryPicker
              serverUrl={serverUrl}
              initialPath={draft.workDirectory}
              onClose={() => setBrowsing(false)}
              onSelect={(path) => {
                setDraft((current) => ({
                  ...current,
                  workDirectory: path,
                  // Offer the folder name as the workspace name when none was typed.
                  name: current.name.trim() === "" ? (path.split("/").filter(Boolean).at(-1) ?? "") : current.name,
                }));
                setBrowsing(false);
              }}
            />
          )}
        </div>
        <TextArea
          label="Standing instructions"
          rows={4}
          value={draft.description}
          hint="Optional. Given to every work-item run in this workspace."
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
        { }
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
