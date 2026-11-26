"use client";

import { PageState } from "@/components/layout/PageCanvas";
import { Suspense, use, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PipelineBoard } from "@/features/pipeline/components/PipelineBoard";

function PipelineDetail({ id }: { id: number }) {
  const params = useSearchParams();
  const [editing, setEditing] = useState(params.get("edit") === "1");

  return <PipelineBoard workbenchPipelineId={id} editing={editing} onEditingChange={setEditing} />;
}

export default function PipelineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = use(params);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return <PageState title="Pipeline" tone="error">“{raw}” is not a pipeline id.</PageState>;
  }

  return (
    <Suspense fallback={<PageState title="Pipeline" tone="loading">Loading pipeline…</PageState>}>
      <PipelineDetail id={id} />
    </Suspense>
  );
}
