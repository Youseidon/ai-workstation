import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { UserIdentity } from "@hydra/shared";
import { config } from "../config/config.ts";

export interface IdentityWorker { port: number; secret: string }

/** Process boundaries also isolate scheduler state, provider caches and broadcasts. */
export function createIdentityWorkers(databasePath: string) {
  const workers = new Map<string, Promise<IdentityWorker>>();
  const children = new Set<ChildProcess>();
  const activeProviders = new Map<ChildProcess, string[]>();
  let closing = false;
  return {
    get(user: UserIdentity): Promise<IdentityWorker> {
      if (closing) return Promise.reject(new Error("Hydra is shutting down"));
      const existing = workers.get(user.id);
      if (existing) return existing;
      const secret = randomBytes(32).toString("hex");
      const directory = `${databasePath}.users/${user.id}`;
      const env = { ...process.env, HOST: "127.0.0.1", PORT: "0", HYDRA_WORKER_SECRET: secret };
      if (!user.ownsLegacyData) {
        Object.assign(env, { HYDRA_DB: resolve(directory, "hydra.sqlite"), SETTINGS_FILE: resolve(directory, "settings.json"), HYDRA_PERSONAL_DEFAULTS: "1" });
      }
      const promise = new Promise<IdentityWorker>((resolvePromise, reject) => {
        const child = fork(fileURLToPath(new URL("../index.ts", import.meta.url)), ["--identity-worker"], {
          cwd: config.repoRoot, env, execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        children.add(child);
        const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Account runtime did not start in time")); }, 30_000);
        child.on("message", (message: unknown) => {
          if (message && typeof message === "object" && "activeProviders" in message && Array.isArray(message.activeProviders)) {
            activeProviders.set(child, message.activeProviders.filter((value): value is string => typeof value === "string"));
          }
          if (message && typeof message === "object" && "port" in message && typeof message.port === "number") {
            clearTimeout(timer);
            resolvePromise({ port: message.port, secret });
          }
        });
        child.once("error", error => {
          clearTimeout(timer);
          children.delete(child);
          activeProviders.delete(child);
          if (workers.get(user.id) === promise) workers.delete(user.id);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          children.delete(child);
          activeProviders.delete(child);
          if (workers.get(user.id) === promise) workers.delete(user.id);
          reject(new Error("Account runtime stopped"));
        });
      });
      workers.set(user.id, promise);
      void promise.catch(() => { if (workers.get(user.id) === promise) workers.delete(user.id); });
      return promise;
    },
    providerInUse(provider: string): boolean {
      return [...activeProviders.values()].some(providers => providers.includes(provider));
    },
    async close(): Promise<void> {
      closing = true;
      await Promise.all([...children].map(child => new Promise<void>(resolvePromise => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) { resolvePromise(); return; }
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, 12_000);
        child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
        child.kill("SIGTERM");
      })));
    },
  };
}
