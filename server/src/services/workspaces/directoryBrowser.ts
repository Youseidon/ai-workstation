import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DirectoryEntry, DirectoryListing } from "@hydra/shared";
import { WorkspaceError } from "../../repositories/workspaces.ts";

// Large directories (node_modules, /usr/lib) would otherwise send tens of
// thousands of rows to a picker nobody scrolls; the operator can type a path.
const ENTRY_LIMIT = 2000;

function absolutePath(value: unknown): string {
  if (value === undefined || value === null || value === "") return homedir();
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new WorkspaceError(422, "validation_error", "Use an absolute path, starting with /.", { path: "Must be absolute" });
  }
  return resolve(value);
}

function fsError(error: unknown, path: string): WorkspaceError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return new WorkspaceError(404, "not_found", `${path} is not an existing directory.`, { path: "Directory does not exist" });
  if (code === "EACCES" || code === "EPERM") return new WorkspaceError(403, "permission_denied", `Hydra cannot read ${path}.`, { path: "Permission denied" });
  if (code === "EEXIST") return new WorkspaceError(409, "already_exists", `${path} already exists.`, { name: "Already exists" });
  return new WorkspaceError(500, "filesystem_error", `Could not access ${path}.`);
}

/** Lists the sub-directories of `path` (the server user's home by default). */
export function listDirectories(value?: unknown): DirectoryListing {
  const path = absolutePath(value);
  let names;
  try {
    if (!statSync(path).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    names = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    throw fsError(error, path);
  }
  const entries: DirectoryEntry[] = [];
  for (const entry of names) {
    const full = join(path, entry.name);
    let isDirectory = entry.isDirectory();
    // Follow symlinks so a linked project folder is still selectable; a
    // dangling or unreadable link is simply skipped.
    if (!isDirectory && entry.isSymbolicLink()) {
      try { isDirectory = statSync(full).isDirectory(); } catch { isDirectory = false; }
    }
    if (isDirectory) entries.push({ name: entry.name, path: full, hidden: entry.name.startsWith(".") });
  }
  entries.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    home: homedir(),
    entries: entries.slice(0, ENTRY_LIMIT),
    truncated: entries.length > ENTRY_LIMIT,
  };
}

/** Creates one new folder `name` inside the existing directory `parent`. */
export function createDirectory(input: { parent?: unknown; name?: unknown }): DirectoryListing {
  const parent = absolutePath(input.parent);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  // A single path segment only: the picker creates one folder in the folder
  // being viewed, never an arbitrary nested or relative path.
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0") || Buffer.byteLength(name) > 255) {
    throw new WorkspaceError(422, "validation_error", "Enter a folder name without slashes.", { name: "Invalid folder name" });
  }
  const target = join(parent, name);
  try {
    mkdirSync(target);
  } catch (error) {
    throw fsError(error, target);
  }
  return listDirectories(target);
}
