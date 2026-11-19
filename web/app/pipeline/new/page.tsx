import { PageState } from "@/components/shell/PageCanvas";
import { Suspense } from "react";
import { PipelineBoard } from "@/components/pipeline/PipelineBoard";

export default function NewPipelinePage() {
  return (
    <Suspense fallback={<PageState title="New pipeline" tone="loading">Loading…</PageState>}>
      <PipelineBoard isNew editing />
    </Suspense>
  );
}
