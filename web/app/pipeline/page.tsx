import { Suspense } from "react";
import { PipelineDashboard } from "@/components/pipeline/PipelineDashboard";

export default function PipelinePage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-fg-dim">Loading pipelines…</div>}>
      <PipelineDashboard />
    </Suspense>
  );
}
