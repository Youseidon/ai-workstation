import { PageState } from "@/components/layout/PageCanvas";
import { Suspense } from "react";
import { PipelineBoard } from "@/features/pipeline/components/PipelineBoard";

export default function NewPipelinePage() {
  return (
    <Suspense fallback={<PageState title="New pipeline" tone="loading">Loading…</PageState>}>
      <PipelineBoard isNew editing />
    </Suspense>
  );
}
