import type { IncomingMessage, ServerResponse } from "node:http";
import { WorkspaceError, workspaces } from "./workspaces.ts";

const MAX_BODY_BYTES = 128 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > MAX_BODY_BYTES) { reject(new WorkspaceError(413, "body_too_large", "Request body is too large")); req.destroy(); }
    });
    req.on("end", () => {
      try {
        const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceError(400, "invalid_json", "Body must be a JSON object");
        resolve(parsed as Record<string, unknown>);
      } catch (error) { reject(error instanceof WorkspaceError ? error : new WorkspaceError(400, "invalid_json", "Body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

function id(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new WorkspaceError(400, "invalid_id", "Resource id must be a positive integer");
  return parsed;
}

function failure(res: ServerResponse, error: unknown): void {
  if (error instanceof WorkspaceError) { json(res, error.status, { error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } }); return; }
  console.error("workspace API failed", error);
  json(res, 500, { error: { code: "internal_error", message: "Workspace operation failed" } });
}

export async function handleWorkspaceApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/workspaces") && !/^\/api\/(programs|suites|prompts)\//.test(url.pathname)) return false;
  try {
    const method = req.method ?? "GET";
    if (url.pathname === "/api/workspaces") {
      if (method === "GET") json(res, 200, { workspaces: workspaces.list() });
      else if (method === "POST") json(res, 201, { workspace: workspaces.create(await body(req)) });
      else json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return true;
    }
    let match = url.pathname.match(/^\/api\/workspaces\/(\d+)(?:\/(tree|prompts|programs))?$/);
    if (match) {
      const workspaceId = id(match[1]!); const child = match[2];
      if (!child && method === "GET") json(res, 200, { workspace: workspaces.get(workspaceId) });
      else if (!child && method === "PATCH") json(res, 200, { workspace: workspaces.update(workspaceId, await body(req)) });
      else if (!child && method === "DELETE") { workspaces.remove(workspaceId); res.writeHead(204); res.end(); }
      else if (child === "tree" && method === "GET") json(res, 200, { workspace: workspaces.tree(workspaceId) });
      else if (child === "prompts" && method === "GET") json(res, 200, { prompts: workspaces.promptOptions(workspaceId) });
      else if (child === "programs" && method === "GET") json(res, 200, { programs: workspaces.tree(workspaceId).programs });
      else if (child === "programs" && method === "POST") json(res, 201, { program: workspaces.createChild("program", workspaceId, await body(req)) });
      else json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return true;
    }
    match = url.pathname.match(/^\/api\/(programs|suites)\/(\d+)\/(suites|prompts)$/);
    if (match && method === "POST") {
      const parent = match[1]!; const child = match[3]!;
      if ((parent === "programs" && child !== "suites") || (parent === "suites" && child !== "prompts")) throw new WorkspaceError(404, "not_found", "Route not found");
      const kind = child === "suites" ? "suite" : "prompt";
      json(res, 201, { [kind]: workspaces.createChild(kind, id(match[2]!), await body(req)) }); return true;
    }
    match = url.pathname.match(/^\/api\/(programs|suites|prompts)\/(\d+)$/);
    if (match) {
      const kind = match[1]!.slice(0, -1) as "program" | "suite" | "prompt"; const resourceId = id(match[2]!);
      if (method === "PATCH") json(res, 200, { [kind]: workspaces.updateChild(kind, resourceId, await body(req)) });
      else if (method === "DELETE") { workspaces.removeChild(kind, resourceId); res.writeHead(204); res.end(); }
      else json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return true;
    }
    json(res, 404, { error: { code: "not_found", message: "Route not found" } }); return true;
  } catch (error) { failure(res, error); return true; }
}
