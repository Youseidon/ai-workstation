"use client";

import { PageState } from "@/components/layout/PageCanvas";
import { Suspense, use } from "react";
import { SuiteBoard } from "@/features/pipeline/components/SuiteBoard";

export default function SuitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = use(params);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return <PageState title="Suite" tone="error">“{raw}” is not a suite id.</PageState>;
  }
  return (
    <Suspense fallback={<PageState title="Suite" tone="loading">Loading suite…</PageState>}>
      <SuiteBoard suiteId={id} />
    </Suspense>
  );
}
