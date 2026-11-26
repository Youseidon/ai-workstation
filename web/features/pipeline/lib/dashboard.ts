import type { OperationsSuite, PipelineDashboardItem, PipelineState, PipelineThroughputDay, StatusTone } from "@hydra/shared";
import { PIPELINE_LABEL, PIPELINE_TONE } from "./status.ts";
import { countStations } from "./station/tree.ts";

export type DirectoryFilter = "all" | "running" | "attention";
export type DashboardPeriod = 7 | 30;

export interface DirectoryEntry {
  id: number;
  name: string;
  context: string;
  search: string;
  href: string;
  done: number;
  total: number;
  attention: number;
  needsAttention: boolean;
  running: boolean;
  status: { label: string; tone: StatusTone };
  durationMs: number | null;
  updatedAt: string;
}

export function percentage(done: number, total: number): number | null {
  return total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : null;
}

export function runOutcomes(days: PipelineThroughputDay[], period: DashboardPeriod) {
  const window = days.slice(-period);
  const complete = window.reduce((sum, day) => sum + day.complete, 0);
  const stopped = window.reduce((sum, day) => sum + day.stopped, 0);
  return { days: window, complete, stopped, total: complete + stopped, rate: percentage(complete, complete + stopped) };
}

function runStatus(state: PipelineState | null): DirectoryEntry["status"] {
  return state === null ? { label: "Not started", tone: "neutral" } : { label: PIPELINE_LABEL[state], tone: PIPELINE_TONE[state] };
}

export function pipelineEntries(items: PipelineDashboardItem[]): DirectoryEntry[] {
  return items.map(({ pipeline, completedSteps, totalSteps, attentionCount, lastRunDurationMs }) => {
    const state = (pipeline.active ?? pipeline.latest)?.state ?? null;
    const programs = [...new Set(pipeline.stages.map((stage) => stage.programName))];
    return {
      id: pipeline.id,
      name: pipeline.name,
      context: `${pipeline.stages.length} ${pipeline.stages.length === 1 ? "suite" : "suites"}${programs.length > 0 ? ` · ${programs.join(", ")}` : ""}`,
      search: [pipeline.name, pipeline.description, ...pipeline.stages.flatMap((stage) => [stage.suiteName, stage.suiteKey, stage.programName, stage.programKey])].join(" ").toLowerCase(),
      href: `/pipeline/${pipeline.id}`,
      done: completedSteps,
      total: totalSteps,
      attention: attentionCount,
      needsAttention: attentionCount > 0 || state === "WAITING_HUMAN" || state === "INTERRUPTED",
      running: pipeline.active?.state === "PLAYING",
      status: runStatus(state),
      durationMs: lastRunDurationMs,
      updatedAt: pipeline.updatedAt,
    };
  });
}

export function suiteEntries(suites: OperationsSuite[], pipelines: PipelineDashboardItem[]): DirectoryEntry[] {
  return suites.map((suite) => {
    const including = pipelines.filter((entry) => entry.pipeline.stages.some((stage) => stage.suiteId === suite.id));
    const owner = including.find((entry) => entry.pipeline.active?.state === "PLAYING" && entry.pipeline.active.currentSuiteId === suite.id)
      ?? including.find((entry) => entry.pipeline.active?.state === "PLAYING")
      ?? including.find((entry) => entry.pipeline.active !== null) ?? including[0];
    const counts = countStations(suite.prompts);
    const verification = suite.latestVerification;
    const running = suite.counts.WORKING > 0 || suite.pipeline?.active?.state === "PLAYING";
    const state = (suite.pipeline?.active ?? suite.pipeline?.latest)?.state ?? null;
    let status = runStatus(state);
    if (verification !== null) {
      status = verification.state === "RUNNING" ? { label: "Verifying", tone: "info" }
        : verification.verdict === "PASS" ? { label: "Verified", tone: "success" }
        : verification.verdict === "FAIL" ? { label: "Check failed", tone: "danger" }
        : verification.verdict === "WARNING" ? { label: "Check warnings", tone: "warning" }
        : verification.state === "ERROR" ? { label: "Check error", tone: "danger" }
        : verification.state === "INTERRUPTED" ? { label: "Check interrupted", tone: "caution" }
        : { label: "Not verified", tone: "neutral" };
    } else if (state === null) status = { label: "Unverified", tone: "neutral" };
    if (running) status = { label: "Running", tone: "info" };
    return {
      id: suite.id,
      name: suite.key === null ? suite.name : `${suite.key} · ${suite.name}`,
      context: `${suite.programName} · ${owner?.pipeline.name ?? "Standalone suite"}`,
      search: [suite.name, suite.key, suite.programName, suite.programKey, owner?.pipeline.name].join(" ").toLowerCase(),
      href: owner === undefined ? `/pipeline/suite/${suite.id}` : `/pipeline/${owner.pipeline.id}?suite=${suite.id}`,
      done: counts.done,
      total: counts.total,
      attention: suite.attentionCount,
      needsAttention: suite.attentionCount > 0 || state === "WAITING_HUMAN" || state === "INTERRUPTED"
        || verification?.verdict === "FAIL" || verification?.verdict === "WARNING"
        || verification?.state === "ERROR" || verification?.state === "INTERRUPTED",
      running,
      status,
      durationMs: null,
      updatedAt: "",
    };
  });
}

export function filterDirectory(entries: DirectoryEntry[], query: string, filter: DirectoryFilter): DirectoryEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => entry.search.includes(needle)
    && (filter === "all" || (filter === "running" ? entry.running : entry.needsAttention)))
    .sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention)
      || Number(b.running) - Number(a.running)
      || b.updatedAt.localeCompare(a.updatedAt)
      || a.name.localeCompare(b.name));
}

export function pageItems<T>(items: T[], requestedPage: number, size: number) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  return { items: items.slice(page * size, (page + 1) * size), page, pages };
}
