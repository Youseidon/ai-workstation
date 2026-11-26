import { PageState } from "@/components/layout/PageCanvas";
import { Suspense } from "react";
import { PipelineDashboard } from "@/features/pipeline/components/PipelineDashboard";

export default function PipelinePage() {
  return (
    <Suspense fallback={<PageState title="Pipelines" tone="loading">Loading pipelines…</PageState>}>
      <PipelineDashboard />
    </Suspense>
  );
}
