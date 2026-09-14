import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fileHashes, HARNESS_ROOT_PREFIX, realDatabaseHarnessRows, repoRoot } from "../realState.ts";
import { ManagedProcess, isPortOpen, waitFor } from "./processes.ts";
import { describeFindings, sweep, type Secret } from "./sweep.ts";
import { WEB_DIST_DIR, ensureWebBuild, harnessWebEnv } from "./webBuild.ts";

/*
 * One harness environment: a temporary root with its own .env, settings and
 * database, the real server and the production web build on ports 4100/3100,
 * and helpers for process lifecycle, artifacts and end-of-run checks
 * (docs/e2e-harness-plan.md section 4.1).
 */

export const SERVER_PORT = 4100;
export const WEB_PORT = 3100;
export const serverUrl = `http://127.0.0.1:${SERVER_PORT}`;
export const webUrl = `http://127.0.0.1:${WEB_PORT}`;

export interface EnvironmentOptions {
  /** Saved setting overrides, written to the root's .agent-console/settings.json before boot. */
  settings?: Record<string, unknown>;
  /** Extra boot-time variables for the root's .env. */
  env?: Record<string, string>;
  /** Extra variables placed directly in the server process environment (harness seams). */
  serverEnv?: Record<string, string>;
  /** Real providers (T3) need the operator's HOME for their logins; fakes get an isolated HOME. */
  realHome?: boolean;
  /** Secrets that must never appear in artifacts, beyond the ones the harness finds itself. */
  secrets?: Secret[];
}

function dotenv(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

/** Secrets the harness runner can see: the operator's token (read only for the sweep) and live test credentials. */
function knownSecrets(): Secret[] {
  const secrets: Secret[] = [];
  const read = (path: string, keys: string[], label: string) => {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (match && keys.includes(match[1]!)) secrets.push({ label: `${label}:${match[1]}`, value: match[2]!.replace(/^["']|["']$/g, "") });
    }
  };
  read(join(repoRoot, ".env"), ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"], "operator");
  read(join(process.env.HOME ?? "", ".config/ai-workstation/e2e-live.env"), ["E2E_TELEGRAM_TEST_BOT_TOKEN", "E2E_TELEGRAM_API_HASH", "E2E_TELEGRAM_USER_SESSION"], "live");
  return secrets;
}

export class HarnessEnvironment {
  readonly root: string;
  readonly logsDir: string;
  readonly homeDir: string;
  readonly server: ManagedProcess;
  readonly web: ManagedProcess;
  private readonly realBefore = fileHashes();
  private readonly secrets: Secret[];
  private readonly operatorPortsBefore: Promise<{ api: boolean; web: boolean }>;

  constructor(private readonly options: EnvironmentOptions = {}) {
    this.operatorPortsBefore = Promise.all([isPortOpen(4000), isPortOpen(3000)]).then(([api, web]) => ({ api, web }));
    this.root = mkdtempSync(HARNESS_ROOT_PREFIX);
    this.logsDir = join(this.root, "logs");
    this.homeDir = join(this.root, "home");
    mkdirSync(this.logsDir, { recursive: true });
    mkdirSync(this.homeDir, { recursive: true });
    mkdirSync(join(this.root, ".agent-console"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(this.root, ".env"),
      dotenv({ HOST: "127.0.0.1", PORT: String(SERVER_PORT), AGENT_API_BASE_URL: serverUrl, ALLOWED_ORIGINS: webUrl, ...options.env }),
    );
    writeFileSync(join(this.root, ".agent-console/settings.json"), `${JSON.stringify(options.settings ?? {}, null, 2)}\n`, { mode: 0o600 });
    this.secrets = [...knownSecrets(), ...(options.secrets ?? [])];

    this.server = new ManagedProcess("server", {
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: join(repoRoot, "server"),
      // Explicit environment: nothing from the operator's shell (such as an exported
      // TELEGRAM_BOT_TOKEN) reaches the harness server, because dotenv never
      // overrides variables that are already set.
      env: {
        PATH: process.env.PATH,
        HOME: options.realHome ? process.env.HOME : this.homeDir,
        LANG: "en_US.UTF-8",
        TZ: "UTC",
        AGENT_CONSOLE_HARNESS: "1",
        AGENT_CONSOLE_REPO_ROOT: this.root,
        ...options.serverEnv,
      },
      logFile: join(this.logsDir, "server.log"),
    });
    this.web = new ManagedProcess("web", {
      command: process.execPath,
      args: [join(repoRoot, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(WEB_PORT)],
      cwd: join(repoRoot, "web"),
      env: harnessWebEnv(serverUrl),
      logFile: join(this.logsDir, "web.log"),
    });
  }

  addSecret(secret: Secret): void {
    this.secrets.push(secret);
  }

  async start(): Promise<void> {
    for (const port of [SERVER_PORT, WEB_PORT]) {
      if (await isPortOpen(port)) throw new Error(`harness port ${port} is already in use; stop whatever is listening there (the harness never uses 4000/3000 instead)`);
    }
    ensureWebBuild(serverUrl, join(this.logsDir, "web-build.log"));
    await this.startServer();
    this.web.start();
    await waitFor("harness web", async () => (await fetch(webUrl)).ok, 60_000, this.web.whenExited());
  }

  async startServer(): Promise<void> {
    this.server.start();
    await waitFor("harness server", async () => (await fetch(`${serverUrl}/api/health`)).ok, 60_000, this.server.whenExited());
  }

  async stopServer(): Promise<void> {
    await this.server.stop();
    await waitFor("harness server port closed", async () => !(await isPortOpen(SERVER_PORT)), 15_000);
  }

  async restartServer(): Promise<void> {
    await this.stopServer();
    await this.startServer();
  }

  /** A fresh git repository under the root, for use as a workspace directory. */
  createGitWorkspace(name: string): string {
    const dir = join(this.root, "workspaces", name);
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: this.homeDir, GIT_AUTHOR_NAME: "harness", GIT_AUTHOR_EMAIL: "harness@example.invalid", GIT_COMMITTER_NAME: "harness", GIT_COMMITTER_EMAIL: "harness@example.invalid" } });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "README.md"), `# ${name}\n`);
    git("add", ".");
    git("commit", "-q", "-m", "fixture");
    return dir;
  }

  /** A consistent single-file copy of the harness database (no WAL), for artifacts and the sweep. */
  databaseCopy(target: string): void {
    const source = join(this.root, ".agent-console/console.sqlite");
    if (!existsSync(source)) return;
    const db = new Database(source, { readonly: true, fileMustExist: true });
    try {
      db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
  }

  /** Copies logs and a database snapshot into a scenario's output directory. */
  collectArtifacts(outputDir: string): void {
    mkdirSync(outputDir, { recursive: true });
    for (const name of ["server.log", "web.log", "web-build.log"]) {
      const source = join(this.logsDir, name);
      if (existsSync(source)) copyFileSync(source, join(outputDir, name));
    }
    this.databaseCopy(join(outputDir, "console.sqlite"));
  }

  /** Stops everything, then runs the end-of-run checks. Throws if any check fails. */
  async dispose(artifactDirs: string[] = []): Promise<void> {
    await this.web.stop();
    await this.server.stop();
    const problems: string[] = [];

    const snapshot = join(this.logsDir, "final-console.sqlite");
    this.databaseCopy(snapshot);
    const findings = sweep([this.logsDir, ...artifactDirs], this.secrets);
    if (findings.length > 0) problems.push(`token sweep failed:\n${describeFindings(findings)}`);

    const pollution = realDatabaseHarnessRows();
    if (pollution.length > 0) problems.push(`the real database contains harness rows:\n${pollution.join("\n")}`);
    const after = fileHashes();
    for (const [file, hash] of Object.entries(this.realBefore)) {
      if (after[file] !== hash) problems.push(`operator file changed during the run: ${file}`);
    }
    const operatorPorts = await this.operatorPortsBefore;
    if (operatorPorts.api && !(await isPortOpen(4000))) problems.push("the operator's server on 4000 stopped answering during the run");
    if (operatorPorts.web && !(await isPortOpen(3000))) problems.push("the operator's web app on 3000 stopped answering during the run");
    if (existsSync(join(repoRoot, "web", WEB_DIST_DIR, "..", ".next-e2e")) === false) problems.push("harness web build directory missing");

    if (problems.length > 0) {
      throw new Error(`harness end-of-run checks failed (root kept at ${this.root}):\n${problems.join("\n")}`);
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}
