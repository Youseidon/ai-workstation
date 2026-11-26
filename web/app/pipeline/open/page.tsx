"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { PageState } from "@/components/layout/PageCanvas";
import { useRouter, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/contexts/workspaceContext";
import { SERVER_URL } from "@/api/serverUrl";
import { workspaceApi } from "@/api/workspacesApi";
import { resolveOpenTarget } from "@/features/pipeline/lib/station/openTarget";

/**
 * One address for "show me this work item": `/pipeline/open?prompt=…&suite=…`.
 * Finds the pipeline that drives the item's suite and lands on it with the item
 * selected, or the suite view when no pipeline drives it. Old Tasks links
 * redirect here.
 */
function OpenResolver() {
  const params = useSearchParams();
  const router = useRouter();
  const { workspaceId, status } = useWorkspace();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (workspaceId === null) {
      if (status === "empty") router.replace("/pipeline");
      return;
    }
    let disposed = false;
    void Promise.all([workspaceApi.operations(SERVER_URL, workspaceId), workspaceApi.listPipelines(SERVER_URL, workspaceId)])
      .then(([snapshot, pipelines]) => {
        if (disposed) return;
        const target = resolveOpenTarget(
          {
            suite: params.get("suite"),
            prompt: params.get("prompt"),
            filter: params.get("filter"),
          },
          snapshot.suites,
          pipelines,
        );
        if (target === null) setMissing(true);
        else router.replace(target);
      })
      .catch(() => {
        if (!disposed) setMissing(true);
      });
    return () => {
      disposed = true;
    };
  }, [workspaceId, status, params, router]);

  if (missing) {
    return (
      <PageState
        title="Work item not found"
        tone="error"
        action={<Link href="/pipeline" className="text-accent hover:underline">Go to pipelines</Link>}
      >
        That work item is not in the selected workspace.
      </PageState>
    );
  }
  return <PageState title="Opening work item" tone="loading">Opening…</PageState>;
}

export default function OpenPage() {
  return (
    <Suspense fallback={<PageState title="Opening work item" tone="loading">Opening…</PageState>}>
      <OpenResolver />
    </Suspense>
  );
}
