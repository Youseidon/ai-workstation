"use client";

import { useState, type ReactNode } from "react";
import { SERVER_URL } from "@/api/serverUrl";
import { workspaceApi } from "@/api/workspacesApi";
import { HydraMark } from "@/components/brand/HydraMark";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useWorkspace } from "@/contexts/workspaceContext";
import { WorkspaceSettingsModal, type WorkspaceDraft } from "@/features/workspaces/components/WorkspaceSettingsModal";

export function WorkspaceGate({ children }: { children: ReactNode }) {
  const { status, workspace, error, refresh } = useWorkspace();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = async (draft: WorkspaceDraft) => {
    if (busy) return;
    setBusy(true);
    try {
      await workspaceApi.create(SERVER_URL, draft);
      setCreating(false);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Workspace could not be created.");
    } finally {
      setBusy(false);
    }
  };

  // Keep the shell unmounted: hidden controls and route effects must not run
  // before the account's workspace has been loaded and selected.
  if (status === "ready" && workspace !== null) return children;

  return (
    <div role="main" aria-labelledby="workspace-gate-title" className="flex min-h-dvh items-center justify-center bg-surface-1 p-6">
      <div className="w-full max-w-lg space-y-5 rounded-xl border border-line bg-surface-2 p-6 sm:p-8">
        <HydraMark size={40} />
        {status === "loading" ? (
          <div role="status" className="space-y-3">
            <h1 id="workspace-gate-title" className="text-xl font-semibold text-fg">Loading your workspaces…</h1>
            <Spinner />
          </div>
        ) : status === "error" ? (
          <>
            <div role="alert" className="space-y-2">
              <h1 id="workspace-gate-title" className="text-xl font-semibold text-fg">Workspaces could not be loaded</h1>
              <p className="text-sm text-fg-muted">{error ?? "Check your connection and try again."}</p>
            </div>
            <Button variant="primary" loading={busy} onClick={async () => {
              setBusy(true);
              try { await refresh(); } finally { setBusy(false); }
            }}>Try again</Button>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <h1 id="workspace-gate-title" className="text-xl font-semibold text-fg">Create a workspace to continue</h1>
              <p className="text-sm leading-relaxed text-fg-muted">
                Specify your workspace first. Choose a project directory on the machine running Hydra to enable prompts and the rest of the app.
              </p>
            </div>
            <Button variant="primary" onClick={() => setCreating(true)}>Create workspace</Button>
            {creating && <WorkspaceSettingsModal
              serverUrl={SERVER_URL}
              open
              workspace={null}
              busy={busy}
              onClose={() => { if (!busy) setCreating(false); }}
              onSubmit={(draft) => { void create(draft); }}
            />}
          </>
        )}
      </div>
    </div>
  );
}
