"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { OperationsSuite } from "@agent-console/shared";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export function SuiteHeader({
  suite,
  providerLabel,
  model,
  workspaceBusy,
  connectionOpen,
  verifying,
  auditing,
  onVerifySuite,
  onAuditSuite,
}: {
  suite: OperationsSuite;
  providerLabel: string;
  model: string | null;
  workspaceBusy: boolean;
  connectionOpen: boolean;
  verifying: boolean;
  auditing: boolean;
  onVerifySuite(): void;
  onAuditSuite(): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const done = suite.counts.DONE;
  const total = suite.prompts.length;
  const waiting = suite.counts.BLOCKED + suite.counts.RECOVERY_NEEDED;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div className="rounded-panel border border-line bg-surface-1 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-fg-dim">
            {suite.workspaceName} › {suite.programName}
          </div>
          <h2 className="mt-1 truncate text-lg text-fg">
            {suite.key !== null && <span className="text-fg-muted">{suite.key} · </span>}
            {suite.name}
          </h2>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-dim">
            <span>
              {done}/{total} done
            </span>
            {suite.counts.WORKING > 0 && <span className="text-info">{suite.counts.WORKING} working</span>}
            {waiting > 0 && <span className="text-warning">{waiting} needs you</span>}
            {suite.counts.READY > 0 && <span>{suite.counts.READY} ready</span>}
            {suite.attentionCount > 0 && (
              <span className="text-warning">{suite.attentionCount} attention</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={workspaceBusy || !connectionOpen}
            loading={verifying}
            onClick={onVerifySuite}
            title={`Verify with ${providerLabel}${model === null ? "" : ` · ${model}`}`}
          >
            {verifying ? "Verifying…" : "Verify suite with agent"}
          </Button>
          <Button size="sm" variant="secondary" loading={auditing} onClick={onAuditSuite}>
            Audit recorded evidence
          </Button>
          <div className="relative" ref={menuRef}>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              aria-label="More suite actions"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((value) => !value)}
            >
              ⋯
            </Button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-md border border-line bg-surface-1 py-1 shadow-xl">
                <Link
                  href={`/pipeline?workspace=${suite.workspaceId}&suite=${suite.id}`}
                  className="block px-3 py-2 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  onClick={() => setMenuOpen(false)}
                >
                  Open pipeline
                </Link>
                <Link
                  href={`/?workspace=${suite.workspaceId}`}
                  className="block px-3 py-2 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  onClick={() => setMenuOpen(false)}
                >
                  Open in Chat
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className={cn("h-full rounded-full bg-success transition-[width]")}
          style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
        />
      </div>
    </div>
  );
}
