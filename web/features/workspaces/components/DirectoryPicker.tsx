"use client";

import { useCallback, useEffect, useState } from "react";
import type { DirectoryListing } from "@hydra/shared";
import { workspaceApi } from "@/api/workspacesApi";
import { Button } from "../../../components/ui/Button";
import { Spinner } from "../../../components/ui/Spinner";
import { cn } from "@/lib/cn";
import { ChevronIcon, FolderIcon } from "./shared";

interface Props {
  serverUrl: string;
  /** Where to open: the path already typed, falling back to the server's home. */
  initialPath: string;
  onSelect(path: string): void;
  onClose(): void;
}

function crumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  return [{ label: "/", path: "/" }, ...parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join("/")}` }))];
}

/** Browses folders on the machine running the Hydra server — not the browser's. */
export function DirectoryPicker({ serverUrl, initialPath, onSelect, onClose }: Props) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const open = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await workspaceApi.directories(serverUrl, path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open that folder.");
    } finally {
      setLoading(false);
    }
  }, [serverUrl]);

  // Opens once, at the path typed when the picker appeared; a half-typed path
  // falls back to the server's home rather than stranding the picker on an error.
  const [startPath] = useState(() => initialPath.trim());
  useEffect(() => {
    let cancelled = false;
    const first = startPath.startsWith("/") ? workspaceApi.directories(serverUrl, startPath) : Promise.reject(new Error("no path"));
    void first
      .catch(() => workspaceApi.directories(serverUrl))
      .then((value) => { if (!cancelled) setListing(value); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not open the folder browser."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [serverUrl, startPath]);

  const createFolder = async () => {
    if (listing === null || newName === null || newName.trim() === "") return;
    setCreating(true);
    setError(null);
    try {
      setListing(await workspaceApi.createDirectory(serverUrl, listing.path, newName));
      setNewName(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the folder.");
    } finally {
      setCreating(false);
    }
  };

  const entries = listing?.entries.filter((entry) => showHidden || !entry.hidden) ?? [];

  return (
    <div className="rounded-md bg-surface-2 ring-1 ring-inset ring-line">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5 font-mono text-xs">
        {listing !== null && crumbs(listing.path).map((crumb, index, all) => (
          <span key={crumb.path} className="flex items-center gap-1">
            <button
              type="button"
              className={cn("rounded px-1 py-0.5 hover:bg-surface-3", index === all.length - 1 ? "text-fg" : "text-fg-muted")}
              onClick={() => void open(crumb.path)}
            >
              {crumb.label}
            </button>
            {index > 0 && index < all.length - 1 && <span className="text-fg-dim">/</span>}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1">
          {listing !== null && (
            <Button size="sm" variant="ghost" onClick={() => void open(listing.home)}>Home</Button>
          )}
          <label className="flex items-center gap-1 px-1 text-fg-dim">
            <input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />
            Hidden
          </label>
        </span>
      </div>

      <ul className="max-h-60 overflow-y-auto py-1" aria-label="Folders">
        {listing?.parent != null && (
          <li>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-3" onClick={() => void open(listing.parent ?? undefined)}>
              <FolderIcon className="size-4 shrink-0" /> ..
            </button>
          </li>
        )}
        {loading && listing === null && (
          <li className="flex items-center gap-2 px-3 py-2 text-xs text-fg-dim"><Spinner size={12} /> Loading…</li>
        )}
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className={cn("group flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-3", entry.hidden ? "text-fg-dim" : "text-fg")}
              onClick={() => void open(entry.path)}
            >
              <FolderIcon className="size-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <ChevronIcon className="size-3.5 shrink-0 text-fg-dim opacity-0 group-hover:opacity-100" />
            </button>
          </li>
        ))}
        {listing !== null && entries.length === 0 && (
          <li className="px-3 py-2 text-xs text-fg-dim">No sub-folders here.</li>
        )}
        {listing?.truncated === true && (
          <li className="px-3 py-2 text-xs text-fg-dim">Too many folders to show them all — type the path instead.</li>
        )}
      </ul>

      {error !== null && <p role="alert" className="border-t border-line px-3 py-2 text-xs text-danger">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-2 py-2">
        {newName === null ? (
          <Button size="sm" variant="ghost" disabled={listing === null} onClick={() => setNewName("")}>New folder</Button>
        ) : (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              aria-label="New folder name"
              className="h-7 w-44 rounded bg-surface-1 px-2 text-sm text-fg ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent/70"
              placeholder="folder-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                // Enter must not submit the surrounding workspace form.
                if (event.key === "Enter") { event.preventDefault(); void createFolder(); }
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setNewName(null); }
              }}
            />
            <Button size="sm" variant="secondary" loading={creating} disabled={newName.trim() === ""} onClick={() => void createFolder()}>Create</Button>
            <Button size="sm" variant="ghost" onClick={() => setNewName(null)}>Cancel</Button>
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {loading && listing !== null && <Spinner size={12} />}
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          <Button size="sm" variant="primary" disabled={listing === null} onClick={() => listing !== null && onSelect(listing.path)}>
            Use this folder
          </Button>
        </span>
      </div>
    </div>
  );
}
