"use client";

import { PageState } from "@/components/layout/PageCanvas";
import { Button } from "@/components/ui/Button";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset(): void }) {
  return (
    <PageState title="Something went wrong" tone="error" action={<Button size="sm" variant="secondary" onClick={reset}>Try again</Button>}>
      This page could not be shown: {error.message || "unknown error"}.
    </PageState>
  );
}
