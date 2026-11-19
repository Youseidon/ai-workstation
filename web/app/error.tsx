"use client";

import { PageState } from "@/components/shell/PageCanvas";
import { Button } from "@/components/ui/Button";

/** A route that fails to render shows the failure inside the shell, with a retry. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset(): void }) {
  return (
    <PageState title="Something went wrong" tone="error" action={<Button size="sm" variant="secondary" onClick={reset}>Try again</Button>}>
      This page could not be shown: {error.message || "unknown error"}.
    </PageState>
  );
}
