import { PageState } from "@/components/shell/PageCanvas";
import { Suspense } from "react";
import { PipelineDashboard } from "@/components/pipeline/PipelineDashboard";

export default function PipelinePage() {
  return (
    <Suspense fallback={<PageState title="Pipelines" tone="loading">Loading pipelines…</PageState>}>
      <PipelineDashboard />
    </Suspense>
  );
}
