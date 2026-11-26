import { addUsageToTotals, emptyUsageTotals, formatUsd, type SessionUsageRow, type UsageTotals } from "@hydra/shared";

export type ReportPeriod = 7 | 30 | "all";
export type ReportMetric = "tokens" | "cost";
export type BreakdownView = "suites" | "tasks" | "sessions";
export type BreakdownSort = "cost" | "tokens" | "recent";
const DAY = 86_400_000;

export interface ReportMeasure {
  totals: UsageTotals;
  priced: number;
  modelRates: number;
  defaultRates: number;
  unpricedUsage: number;
  cachedInput: number;
}

export function measureSessions(sessions: SessionUsageRow[]): ReportMeasure {
  const result: ReportMeasure = { totals: emptyUsageTotals(), priced: 0, modelRates: 0, defaultRates: 0, unpricedUsage: 0, cachedInput: 0 };
  for (const session of sessions) {
    addUsageToTotals(result.totals, session.usage, session.cost.usd);
    if (session.usage === null) continue;
    result.cachedInput += Math.min(session.usage.inputTokens, session.usage.cachedInputTokens);
    if (session.cost.usd === null) { result.unpricedUsage++; continue; }
    result.priced++;
    if (session.cost.rateSource === "model") result.modelRates++;
    if (session.cost.rateSource === "provider_default") result.defaultRates++;
  }
  return result;
}

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? Math.min(100, Math.max(0, part / whole * 100)) : null;
}

export function percentLabel(value: number | null): string {
  return value === null ? "—" : value > 0 && value < 0.1 ? "<0.1%" : value > 99.9 && value < 100 ? ">99.9%" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

export function estimateLabel(measure: ReportMeasure): string {
  return measure.priced === 0 ? "—" : formatUsd(measure.totals.estimatedUsd);
}

export function tokensValue(measure: ReportMeasure): number | null {
  return measure.totals.sessionsWithUsage === 0 ? null : measure.totals.totalTokens;
}

export function metricValue(measure: ReportMeasure, metric: ReportMetric): number | null {
  return metric === "tokens" ? tokensValue(measure) : measure.priced === 0 ? null : measure.totals.estimatedUsd;
}

export function selectSessions(sessions: SessionUsageRow[], generatedAt: string, period: ReportPeriod, provider: string): SessionUsageRow[] {
  const end = Date.parse(generatedAt);
  const start = period === "all" ? -Infinity : Math.floor(end / DAY) * DAY - (period - 1) * DAY;
  return sessions.filter((session) => {
    if (provider !== "all" && session.provider !== provider) return false;
    if (period === "all") return true;
    const time = Date.parse(session.startedAt);
    return Number.isFinite(time) && time >= start && time <= end;
  });
}

export interface ReportBucket {
  start: string;
  end: string;
  measure: ReportMeasure;
}

export function buildTimeline(sessions: SessionUsageRow[], generatedAt: string, period: ReportPeriod) {
  const snapshotDay = Math.floor(Date.parse(generatedAt) / DAY);
  const dated = sessions.flatMap((session) => {
    const time = Date.parse(session.startedAt);
    return Number.isFinite(time) ? [{ session, day: Math.floor(time / DAY) }] : [];
  });
  let first = period === "all" ? snapshotDay : snapshotDay - (period - 1);
  let last = snapshotDay;
  if (period === "all") {
    for (const item of dated) { first = Math.min(first, item.day); last = Math.max(last, item.day); }
  }
  const bucketDays = Math.max(1, Math.ceil((last - first + 1) / 30));
  const groups = new Map<number, SessionUsageRow[]>();
  for (const item of dated) {
    if (item.day < first || item.day > last) continue;
    const index = Math.floor((item.day - first) / bucketDays);
    const group = groups.get(index) ?? [];
    group.push(item.session);
    groups.set(index, group);
  }
  const buckets: ReportBucket[] = [];
  for (let day = first, index = 0; day <= last; day += bucketDays, index++) {
    buckets.push({ start: new Date(day * DAY).toISOString().slice(0, 10), end: new Date(Math.min(day + bucketDays - 1, last) * DAY).toISOString().slice(0, 10), measure: measureSessions(groups.get(index) ?? []) });
  }
  return { buckets, bucketDays, undated: sessions.length - dated.length };
}

export interface ReportGroup {
  id: string;
  name: string;
  context: string;
  href: string | null;
  sessions: SessionUsageRow[];
  measure: ReportMeasure;
  latest: string;
}

function groupSessions(sessions: SessionUsageRow[], identify: (session: SessionUsageRow) => Omit<ReportGroup, "sessions" | "measure" | "latest">) {
  const grouped = new Map<string, { info: ReturnType<typeof identify>; sessions: SessionUsageRow[] }>();
  for (const session of sessions) {
    const info = identify(session);
    const group = grouped.get(info.id) ?? { info, sessions: [] };
    group.sessions.push(session);
    grouped.set(info.id, group);
  }
  return [...grouped.values()].map(({ info, sessions: members }) => ({
    ...info, sessions: members, measure: measureSessions(members),
    latest: members.reduce((latest, session) => Number.isFinite(Date.parse(session.startedAt)) && (!Number.isFinite(Date.parse(latest)) || Date.parse(session.startedAt) > Date.parse(latest)) ? session.startedAt : latest, ""),
  }));
}

export function providerGroups(sessions: SessionUsageRow[]): ReportGroup[] {
  return groupSessions(sessions, (session) => ({ id: session.provider, name: session.provider, context: "", href: null }));
}

export function breakdownGroups(sessions: SessionUsageRow[], view: BreakdownView): ReportGroup[] {
  return groupSessions(sessions, (session) => {
    if (view === "sessions") return { id: session.id, name: session.promptKey ? `${session.promptKey} · ${session.promptTitle}` : session.promptTitle, context: [session.provider, session.model, session.role].filter(Boolean).join(" · "), href: `/activity?run=${encodeURIComponent(session.id)}` };
    const unlinked = session.promptId === null || session.suiteId === null || session.programId === null;
    if (unlinked) return { id: "unassigned", name: "Unassigned sessions", context: "Custom runs, research & consults", href: null };
    return view === "suites"
      ? { id: `suite-${session.suiteId}`, name: session.suiteName, context: session.programName, href: `/pipeline/suite/${session.suiteId}` }
      : { id: `task-${session.promptId}`, name: session.promptKey ? `${session.promptKey} · ${session.promptTitle}` : session.promptTitle, context: `${session.suiteName} · ${session.programName}`, href: `/pipeline/open?prompt=${session.promptId}` };
  });
}

export function filterBreakdown(groups: ReportGroup[], query: string, sort: BreakdownSort): ReportGroup[] {
  const needle = query.trim().toLowerCase();
  return groups.filter((group) => `${group.name} ${group.context}`.toLowerCase().includes(needle))
    .sort((a, b) => {
      const av = sort === "recent" ? (Number.isFinite(Date.parse(a.latest)) ? Date.parse(a.latest) : null) : sort === "cost" ? metricValue(a.measure, "cost") : tokensValue(a.measure);
      const bv = sort === "recent" ? (Number.isFinite(Date.parse(b.latest)) ? Date.parse(b.latest) : null) : sort === "cost" ? metricValue(b.measure, "cost") : tokensValue(b.measure);
      if (av === null) return bv === null ? a.name.localeCompare(b.name) : 1;
      if (bv === null) return -1;
      return bv - av || a.name.localeCompare(b.name);
    });
}

export function reportCsv(sessions: SessionUsageRow[]): string {
  const headers = ["session_id", "provider", "model", "role", "state", "started_at", "ended_at", "suite", "task", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "api_estimate_usd", "rate_source", "input_rate_usd_per_mtok", "cached_input_rate_usd_per_mtok", "output_rate_usd_per_mtok"];
  const cell = (value: string | number | null | undefined): string => {
    let text = value === null || value === undefined ? "" : String(value);
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [headers, ...sessions.map((session) => [session.id, session.provider, session.model, session.role, session.state, session.startedAt, session.endedAt, session.suiteName, session.promptTitle, session.usage?.inputTokens, session.usage?.cachedInputTokens, session.usage?.outputTokens, session.usage?.reasoningOutputTokens, session.usage?.totalTokens, session.cost.usd, session.cost.rateSource, session.cost.rates?.inputPerMTok, session.cost.rates?.cachedInputPerMTok, session.cost.rates?.outputPerMTok])].map((row) => row.map(cell).join(",")).join("\r\n");
}
