import { homedir } from "node:os";
import { resolve } from "node:path";

export function defaultDatabasePath(): string {
  const base = process.env.XDG_STATE_HOME?.trim() || resolve(homedir(), ".local/state");
  return resolve(base, "hydra/hydra.sqlite");
}

export function configuredDatabasePath(): string {
  return process.env.HYDRA_DB?.trim() ? resolve(process.env.HYDRA_DB) : defaultDatabasePath();
}
