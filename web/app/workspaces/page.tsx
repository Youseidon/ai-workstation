"use client";

import { PageChrome } from "@/components/shell/chrome";
import { WorkspaceManager } from "@/components/WorkspaceManager";
import { SERVER_URL } from "@/lib/serverUrl";

export default function WorkspacesPage() {
  return (
    <main className="flex h-full flex-col bg-surface-0">
      <PageChrome title="Workspaces" />
      <WorkspaceManager serverUrl={SERVER_URL} />
    </main>
  );
}
