import { Suspense } from "react";
import { PipelineBoard } from "@/components/pipeline/PipelineBoard";

export default function PipelinePage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-fg-dim">Loading pipeline…</div>}>
      <PipelineBoard />
    </Suspense>
  );
}
