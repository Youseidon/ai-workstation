"use client";

import { WorkspaceManager } from "@/features/workspaces/components/WorkspaceManager";
import { SERVER_URL } from "@/api/serverUrl";

export default function WorkspacesPage() {
  return (
    <div className="flex h-full flex-col">
      <WorkspaceManager serverUrl={SERVER_URL} />
    </div>
  );
}
