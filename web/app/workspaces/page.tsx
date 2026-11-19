"use client";

import { WorkspaceManager } from "@/components/WorkspaceManager";
import { SERVER_URL } from "@/lib/serverUrl";

export default function WorkspacesPage() {
  return (
    <div className="flex h-full flex-col">
      <WorkspaceManager serverUrl={SERVER_URL} />
    </div>
  );
}
