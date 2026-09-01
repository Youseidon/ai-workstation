"use client";

import { useMemo, useState } from "react";
import type { OperationsSuite } from "@agent-console/shared";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";

export function SuiteRail({
  suites,
  selectedSuiteId,
  loading,
  onSelect,
}: {
  suites: OperationsSuite[];
  selectedSuiteId: number | null;
  loading: boolean;
  onSelect(suiteId: number): void;
}) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible =
      needle === ""
        ? suites
        : suites.filter((suite) => {
            const haystack = [
              suite.name,
              suite.key ?? "",
              suite.workspaceName,
              suite.programName,
              suite.programKey ?? "",
            ]
              .join(" ")
              .toLowerCase();
            return haystack.includes(needle);
          });

    const byWorkspace = new Map<string, Map<string, OperationsSuite[]>>();
    for (const suite of visible) {
      const workspace = suite.workspaceName;
      const program = suite.programName;
      let programs = byWorkspace.get(workspace);
      if (programs === undefined) {
        programs = new Map();
        byWorkspace.set(workspace, programs);
      }
      const list = programs.get(program) ?? [];
      list.push(suite);
      programs.set(program, list);
    }
    return [...byWorkspace.entries()].map(([workspace, programs]) => ({
      workspace,
      programs: [...programs.entries()].map(([program, items]) => ({ program, items })),
    }));
  }, [suites, query]);

  return (
    <aside className="flex min-h-0 flex-col border-line bg-surface-1 xl:border-r">
      <div className="border-b border-line p-3">
        <label className="block">
          <span className="sr-only">Search suites</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search suites…"
            className="w-full rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-dim outline-none focus:border-line-strong"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : suites.length === 0 ? (
          <p className="text-xs leading-relaxed text-fg-dim">
            No suites yet. Create programs and suites on the Workspaces page.
          </p>
        ) : groups.length === 0 ? (
          <p className="text-xs text-fg-dim">No suites match “{query.trim()}”.</p>
        ) : (
          groups.map(({ workspace, programs }) =>
            programs.map(({ program, items }) => (
              <div key={`${workspace}::${program}`} className="mb-4">
                <div className="mb-1.5 truncate px-1 text-[10px] uppercase tracking-wider text-fg-dim">
                  {workspace} › {program}
                </div>
                {items.map((entry) => {
                  const done = entry.counts.COMPLETE;
                  const total = entry.prompts.length;
                  const ratio = total === 0 ? 0 : Math.round((done / total) * 100);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => onSelect(entry.id)}
                      aria-current={selectedSuiteId === entry.id ? "true" : undefined}
                      className={cn(
                        "mb-1.5 w-full rounded-panel border p-2.5 text-left transition-colors",
                        selectedSuiteId === entry.id
                          ? "border-line-strong bg-surface-3"
                          : "border-line bg-surface-2 hover:bg-surface-3",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 text-[13px]">
                        <span className="truncate">
                          {entry.key !== null && <span className="text-fg-muted">{entry.key} · </span>}
                          {entry.name}
                        </span>
                        {entry.attentionCount > 0 && <Badge tone="warning">{entry.attentionCount}</Badge>}
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3">
                        <div
                          className="h-full rounded-full bg-success transition-[width]"
                          style={{ width: `${ratio}%` }}
                        />
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className="text-fg-dim">
                          {done}/{total} done
                        </span>
                        {entry.latestVerification === null ? (
                          <Badge tone="neutral">unverified</Badge>
                        ) : (
                          <Badge
                            tone={
                              entry.latestVerification.state === "RUNNING"
                                ? "info"
                                : entry.latestVerification.verdict === "PASS"
                                  ? "success"
                                  : entry.latestVerification.verdict === "FAIL"
                                    ? "danger"
                                    : "warning"
                            }
                            dot
                            pulse={entry.latestVerification.state === "RUNNING"}
                          >
                            {entry.latestVerification.state === "RUNNING"
                              ? "verifying"
                              : entry.latestVerification.verdict ?? entry.latestVerification.state}
                          </Badge>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )),
          )
        )}
      </div>
    </aside>
  );
}
