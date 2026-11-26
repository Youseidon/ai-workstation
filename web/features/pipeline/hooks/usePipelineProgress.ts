"use client";

import { useEffect, useState } from "react";
import type { OperationsSnapshot, PipelineFlowchartView } from "@hydra/shared";
import { workspaceApi } from "@/api/workspacesApi";
import { SERVER_URL } from "@/api/serverUrl";

/** A scoped membership snapshot for every stage, including suites never opened in this browser. */
export function usePipelineProgress({ workspaceId, pipelineId, suiteIds, snapshot }: {
  workspaceId: number | null;
  pipelineId: number | null;
  suiteIds: number[];
  snapshot: OperationsSnapshot | null;
}) {
  const scope = `${workspaceId}:${pipelineId}`;
  const membership = suiteIds.join(",");
  const [loaded, setLoaded] = useState<{ scope: string; flows: Map<number, PipelineFlowchartView> } | null>(null);
  useEffect(() => {
    if (workspaceId === null || pipelineId === null || snapshot === null) return;
    let current = true;
    const ids = membership === "" ? [] : membership.split(",").map(Number);
    void Promise.allSettled(ids.map((id) => workspaceApi.pipelineFlowchart(SERVER_URL, pipelineId, id)))
      .then((results) => {
        if (!current) return;
        const flows = new Map<number, PipelineFlowchartView>();
        for (const result of results) if (result.status === "fulfilled") flows.set(result.value.suiteId, result.value);
        // Failed telemetry replaces an old success tick with an explicit unknown.
        setLoaded({ scope, flows });
      });
    return () => { current = false; };
  }, [scope, membership, snapshot, workspaceId, pipelineId]);
  return snapshot !== null && pipelineId !== null && loaded?.scope === scope ? loaded.flows : null;
}
