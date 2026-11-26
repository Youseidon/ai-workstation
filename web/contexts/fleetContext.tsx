"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { OperationsSnapshot, PipelineFlowchartView, PipelineRecord } from "@hydra/shared";
import { fleetMetadata } from "../features/agents/lib/fleet";
import { stopTargets, type StopTargets } from "../features/stop/lib/stopTargets";
import { useHydra } from "../hooks/useHydra";
import { workspaceApi } from "../api/workspacesApi";
import { SERVER_URL } from "../api/serverUrl";

const FleetContext = createContext<ReturnType<typeof fleetMetadata> & { targets: StopTargets; loading: boolean; error: string | null; refresh(): void }>({ origins: {}, queued: [], targets: { pipelines: [], agents: [] }, loading: true, error: null, refresh() {} });

/** One metadata subscription shared by the rail and command center. No histories are loaded. */
export function FleetProvider({ children }: { children: ReactNode }) {
  const { runs, operationsRevision, connection } = useFleetConsole();
  const [data, setData] = useState<{ operations: OperationsSnapshot | null; pipelines: PipelineRecord[]; flowcharts: Record<string, PipelineFlowchartView>; loading: boolean; error: string | null }>({ operations: null, pipelines: [], flowcharts: {}, loading: true, error: null });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(() => {
      void Promise.all([workspaceApi.operations(SERVER_URL), workspaceApi.listPipelines(SERVER_URL)])
        .then(async ([operations, pipelines]) => {
          const candidates = operations.suites.flatMap(suite => {
            const active = suite.pipeline?.active;
            if (!active || active.state !== "PLAYING" || active.currentRunId !== null || active.currentPromptId === null) return [];
            const pipeline = pipelines.find(pipeline => pipeline.active?.id === active.pipelineRunId);
            return pipeline ? [{ id: active.id, pipelineId: pipeline.id, suiteId: suite.id }] : [];
          });
          const results = await Promise.allSettled(candidates.map(async candidate => [candidate.id, await workspaceApi.pipelineFlowchart(SERVER_URL, candidate.pipelineId, candidate.suiteId)] as const));
          const flowcharts: Record<string, PipelineFlowchartView> = {};
          for (const result of results) if (result.status === "fulfilled") flowcharts[result.value[0]] = result.value[1];
          if (!disposed) setData({ operations, pipelines, flowcharts, loading: false, error: results.some(result => result.status === "rejected") ? "Some queued assignments could not be loaded; agents and models will be resolved at launch." : null });
        })
        .catch((error: unknown) => { if (!disposed) setData(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not load fleet metadata" })); });
    }, 150);
    return () => { disposed = true; clearTimeout(timer); };
  }, [operationsRevision, connection, revision]);
  const metadata = useMemo(() => fleetMetadata(data.operations, data.pipelines, runs, data.flowcharts), [data.operations, data.pipelines, data.flowcharts, runs]);
  const targets = useMemo(() => stopTargets(data.operations, data.pipelines, runs), [data.operations, data.pipelines, runs]);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  return <FleetContext.Provider value={{ ...metadata, targets, loading: data.loading, error: data.error, refresh }}>{children}</FleetContext.Provider>;
}

export function useFleetMetadata() { return useContext(FleetContext); }

/** Keep last-known fleet visibility separate from Chat's launch/recovery state. */
export function useFleetConsole() {
  const api = useHydra();
  const frozen = api.disconnectedRuns?.length > 0;
  return { ...api, runs: frozen ? api.disconnectedRuns : api.runs, stale: api.connection !== "open" || frozen };
}
