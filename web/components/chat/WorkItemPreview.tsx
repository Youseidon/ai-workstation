"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Modal } from "@/components/ui/Modal";
import type { PromptWorkItem } from "@/lib/log";
import { SERVER_URL } from "@/lib/serverUrl";
import { workspaceApi } from "@/lib/workspacesApi";

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; content: string; status: string };

/** Read-only markdown preview of a work item's current text, fetched on open. */
export function WorkItemPreview({ item, open, onClose }: { item: PromptWorkItem; open: boolean; onClose(): void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    workspaceApi.promptPreview(SERVER_URL, item.id)
      .then(prompt => { if (!cancelled) setLoaded({ state: "ready", content: prompt.content, status: prompt.status }); })
      .catch((error: unknown) => { if (!cancelled) setLoaded({ state: "error", message: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; };
  }, [open, item.id]);

  return <Modal open={open} onClose={onClose} size="xl"
    title={item.key === null ? item.title : `${item.key} — ${item.title}`}
    description={loaded.state === "ready" ? `Work item · ${loaded.status.toLowerCase()} · current text (may have been edited since this run)` : "Work item"}
    footer={<a href={`/pipeline/open?prompt=${item.id}`} className="text-sm text-accent hover:underline">Open in Pipeline</a>}>
    {loaded.state === "loading" ? <p className="text-sm text-fg-muted">Loading work item…</p>
      : loaded.state === "error" ? <p role="alert" className="text-sm text-danger">Work item unavailable: {loaded.message}</p>
      : loaded.content.trim() === "" ? <p className="text-sm text-fg-muted">This work item has no text.</p>
      : <article className="prompt-document"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{loaded.content}</ReactMarkdown></article>}
  </Modal>;
}
