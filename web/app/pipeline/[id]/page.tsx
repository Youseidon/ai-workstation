"use client";

import { Suspense, use, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PipelineBoard } from "@/components/pipeline/PipelineBoard";

function PipelineDetail({ id }: { id: number }) {
  const params = useSearchParams();
  const [editing, setEditing] = useState(params.get("edit") === "1");

  return <PipelineBoard workbenchPipelineId={id} editing={editing} onEditingChange={setEditing} />;
}

export default function PipelineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = use(params);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return <div className="p-6 text-sm text-danger">Invalid pipeline id.</div>;
  }

  return (
    <Suspense fallback={<div className="p-6 text-sm text-fg-dim">Loading pipeline…</div>}>
      <PipelineDetail id={id} />
    </Suspense>
  );
}
