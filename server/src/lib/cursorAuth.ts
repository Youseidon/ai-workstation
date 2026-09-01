import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fetchJson, writeJsonAtomic } from "../adapters/accountUsage.ts";

/**
 * Cursor CLI stores login tokens at ~/.config/cursor/auth.json. The IDE keeps
 * the same access token in state.vscdb. Plan usage needs that login token —
 * CURSOR_API_KEY is not accepted by the dashboard endpoints.
 */

const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const CURSOR_API_BASE = process.env.CURSOR_API_ENDPOINT?.replace(/\/$/, "") || "https://api2.cursor.sh";

export interface CursorAuthFile {
  accessToken: string;
  refreshToken: string | null;
}

export function cursorAuthJsonPath(): string {
  return join(homedir(), ".config", "cursor", "auth.json");
}

/** IDE `state.vscdb` locations, including the Windows path when running under WSL. */
export function cursorStateDbPaths(): string[] {
  const home = homedir();
  const paths = [
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  const appData = process.env.APPDATA;
  if (appData) paths.push(join(appData, "Cursor", "User", "globalStorage", "state.vscdb"));
  try {
    const usersRoot = "/mnt/c/Users";
    if (existsSync(usersRoot)) {
      for (const entry of readdirSync(usersRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "Public" || entry.name === "Default" || entry.name === "Default User" || entry.name === "All Users") {
          continue;
        }
        paths.push(
          join(usersRoot, entry.name, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
        );
      }
    }
  } catch {
    // ignore unreadable mounts
  }
  return paths;
}

export function cursorLoginPresent(): boolean {
  if (existsSync(cursorAuthJsonPath())) return true;
  return cursorStateDbPaths().some((path) => existsSync(path));
}

export async function resolveCursorAccessToken(): Promise<string | null> {
  const fromFile = readCursorAuthFile();
  if (fromFile?.accessToken) return fromFile.accessToken;
  return readCursorTokenFromStateDb();
}

export function readCursorAuthFile(): CursorAuthFile | null {
  const path = cursorAuthJsonPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken : null;
    if (!accessToken) return null;
    const refreshToken = typeof parsed.refreshToken === "string" ? parsed.refreshToken : null;
    return { accessToken, refreshToken };
  } catch {
    return null;
  }
}

export function readCursorTokenFromStateDb(): string | null {
  for (const dbPath of cursorStateDbPaths()) {
    if (!existsSync(dbPath)) continue;
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const row = db
          .prepare("SELECT value FROM ItemTable WHERE key = ?")
          .get("cursorAuth/accessToken") as { value?: string } | undefined;
        if (typeof row?.value === "string" && row.value !== "") return row.value;
      } finally {
        db.close();
      }
    } catch {
      // try next path
    }
  }
  return null;
}

export async function refreshCursorAccessToken(): Promise<string | null> {
  const auth = readCursorAuthFile();
  if (auth?.refreshToken == null || auth.refreshToken === "") return null;
  const response = await fetchJson(`${CURSOR_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CURSOR_OAUTH_CLIENT_ID,
      refresh_token: auth.refreshToken,
    }),
  });
  if (!response.ok) return null;
  const body = response.body as {
    access_token?: string;
    refresh_token?: string;
    shouldLogout?: boolean;
  } | null;
  if (body?.shouldLogout === true) return null;
  const accessToken = typeof body?.access_token === "string" ? body.access_token : null;
  if (accessToken === null || accessToken === "") return null;
  const refreshToken =
    typeof body?.refresh_token === "string" && body.refresh_token !== ""
      ? body.refresh_token
      : auth.refreshToken;
  try {
    writeJsonAtomic(cursorAuthJsonPath(), { accessToken, refreshToken });
  } catch {
    // Still return the fresh token even if persistence fails.
  }
  return accessToken;
}

export async function fetchCursorDashboard(
  method: "GetCurrentPeriodUsage" | "GetPlanInfo",
  accessToken: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  return fetchJson(`${CURSOR_API_BASE}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
  });
}
