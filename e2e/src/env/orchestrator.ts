import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fileHashes, HARNESS_ROOT_PREFIX, realDatabaseHarnessRows, repoRoot } from "../realState.ts";
import { randomBytes } from "node:crypto";
import { FakeProvider } from "../drivers/fakeProvider.ts";
import { FakePhone, type PhoneDriver } from "../drivers/phone.ts";
import { FakeTelegramServer, type ApiCall, type FakeBot } from "../fakes/telegramServer.ts";
import { LIVE_ENV_PATH, LiveSetupError, loadLiveConfig } from "./liveConfig.ts";
import { PreflightError, preflightBot } from "./telegramPreflight.ts";
import { TelegramRouteProxy, type ProxiedCall, type RouteCut } from "./telegramRouteProxy.ts";
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
  /** Route Grok to the scripted fake agent, on the live Progress API path or the inline path. */
  fakeProvider?: "live" | "inline";
  /**
   * Telegram backend for task control. Absent means task control stays off.
   * The real backend (T3) always runs through the route proxy; the fake one
   * does when `proxy` is set, so network cuts run on both backends.
   */
  telegram?: {
    backend: "fake" | "real";
    remoteActions?: boolean;
    notifications?: boolean;
    botId?: number;
    proxy?: boolean;
    /** Fake only: the chat and the bot's update queue start with what an earlier run left behind (S-H6-21). */
    leftoversFromEarlierRun?: boolean;
  };
}

const REAL_TELEGRAM = "https://api.telegram.org";

export const FAKE_OPERATOR = { id: 5_550_001, firstName: "Operator", username: "harness_operator" };

function dotenv(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

/**
 * Secrets the harness runner can see: the operator's token (read only for the sweep) and live test
 * credentials. Ids (api_id, bot ids, user ids) are identities, not secrets, and are not swept.
 */
export function knownSecrets(livePath = LIVE_ENV_PATH, repoEnvPath = join(repoRoot, ".env")): Secret[] {
  const secrets: Secret[] = [];
  const read = (path: string, keys: string[], label: string) => {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (match && keys.includes(match[1]!)) secrets.push({ label: `${label}:${match[1]}`, value: match[2]!.replace(/^["']|["']$/g, "") });
    }
  };
  read(repoEnvPath, ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"], "operator");
  read(livePath, ["E2E_TELEGRAM_TEST_BOT_TOKEN", "E2E_TELEGRAM_API_HASH", "E2E_TELEGRAM_USER_SESSION"], "live");
  return secrets;
}

/** The operator's own bot id (never the token), so the server guard can refuse it. */
function operatorBotId(): string | null {
  if (existsSync(LIVE_ENV_PATH)) {
    const match = readFileSync(LIVE_ENV_PATH, "utf8").match(/^E2E_TELEGRAM_OPERATOR_BOT_ID=(\d+)\s*$/m);
    if (match) return match[1]!;
  }
  const repoEnv = join(repoRoot, ".env");
  if (!existsSync(repoEnv)) return null;
  return readFileSync(repoEnv, "utf8").match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*["']?(\d+):/m)?.[1] ?? null;
}

/**
 * What a shared test bot carries from an earlier run: its question and answer cards with live
 * buttons, and pending updates for a plain message, a reply, a tap and an old /start code.
 */
async function seedLeftovers(server: FakeTelegramServer, bot: FakeBot, chat: { id: number; type: "private" }): Promise<void> {
  server.registerChat(chat);
  const send = async (body: Record<string, unknown>) => ((await (await fetch(`${server.url}/bot${bot.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat.id, ...body }) })).json()) as { result: { message_id: number } }).result.message_id;
  const question = await send({ text: "Task needs input: Earlier run task\n\nBlocked on: an earlier run.\n\nReply to this message with your answer." });
  const answer = await send({ text: "Your answer:\nOld answer", reply_markup: { inline_keyboard: [[{ text: "Save answer", callback_data: `tc_${"A".repeat(24)}` }, { text: "Answer and resume", callback_data: `tc_${"B".repeat(24)}` }]] } });
  server.userSendsMessage(bot, FAKE_OPERATOR, chat, "hello from an earlier run");
  server.userSendsMessage(bot, FAKE_OPERATOR, chat, "Old reply", { replyToMessageId: question });
  server.userTapsButton(bot, FAKE_OPERATOR, chat, answer, `tc_${"B".repeat(24)}`);
  server.userSendsMessage(bot, FAKE_OPERATOR, chat, "/start oldpairingcode1234");
}

export class HarnessEnvironment {
  readonly root: string;
  readonly logsDir: string;
  readonly homeDir: string;
  readonly server: ManagedProcess;
  readonly web: ManagedProcess;
  readonly fakeProvider: FakeProvider;
  telegramServer: FakeTelegramServer | null = null;
  telegramBot: FakeBot | null = null;
  telegramProxy: TelegramRouteProxy | null = null;
  phone: PhoneDriver | null = null;
  private telegram: { id: string; username: string; token: string } | null = null;
  private realPhone: import("../drivers/telegramUserPhone.ts").TelegramUserPhone | null = null;
  private readonly serverSpecEnv: NodeJS.ProcessEnv;
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
    this.fakeProvider = new FakeProvider(this.root);
    const telegramSettings = options.telegram
      ? { "taskControl.enabled": true, "taskControl.transport": "telegram", "taskControl.notificationsEnabled": options.telegram.notifications ?? true, "taskControl.remoteActionsEnabled": options.telegram.remoteActions ?? true }
      : {};
    const settings = { ...(options.fakeProvider ? FakeProvider.settings(options.fakeProvider) : {}), ...telegramSettings, ...options.settings };
    writeFileSync(join(this.root, ".agent-console/settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    this.secrets = [...knownSecrets(), ...(options.secrets ?? [])];

    // Explicit environment: nothing from the operator's shell (such as an exported
    // TELEGRAM_BOT_TOKEN) reaches the harness server, because dotenv never
    // overrides variables that are already set.
    this.serverSpecEnv = {
      PATH: process.env.PATH,
      HOME: options.realHome ? process.env.HOME : this.homeDir,
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      AGENT_CONSOLE_HARNESS: "1",
      AGENT_CONSOLE_REPO_ROOT: this.root,
      // Code coverage (plan 12.4): V8 writes the server's coverage here when a coverage run asks for it.
      ...(process.env.E2E_COVERAGE_DIR ? { NODE_V8_COVERAGE: process.env.E2E_COVERAGE_DIR } : {}),
      ...FakeProvider.serverEnv(this.root),
      ...options.serverEnv,
    };
    this.server = new ManagedProcess("server", {
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: join(repoRoot, "server"),
      env: this.serverSpecEnv,
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
    if (this.options.telegram?.backend === "fake") await this.startFakeTelegram();
    if (this.options.telegram?.backend === "real") await this.startRealTelegram();
    await this.startServer();
    this.web.start();
    await waitFor("harness web", async () => (await fetch(webUrl)).ok, 60_000, this.web.whenExited());
  }

  private async startFakeTelegram(): Promise<void> {
    const server = new FakeTelegramServer();
    await server.listen();
    const botId = this.options.telegram?.botId ?? 700_000_000 + Math.floor(Math.random() * 99_999);
    const bot: FakeBot = { id: botId, username: "harness_fake_bot", token: `${botId}:${randomBytes(27).toString("base64url")}` };
    server.addBot(bot);
    this.telegramServer = server;
    this.telegramBot = bot;
    const chat = { id: FAKE_OPERATOR.id, type: "private" as const };
    if (this.options.telegram?.leftoversFromEarlierRun) await seedLeftovers(server, bot, chat);
    this.phone = new FakePhone(server, bot, FAKE_OPERATOR, chat);
    this.addSecret({ label: "harness:fake-bot-token", value: bot.token });
    await this.connectTelegram({ upstream: server.url, token: bot.token, botId: String(bot.id), forbidden: operatorBotId(), useProxy: this.options.telegram?.proxy === true, pollTimeoutSeconds: "2" });
    // The preflight is the harness's own traffic; `calls` records what the harness server does.
    server.calls.splice(0);
  }

  /** Real Telegram (T3): the registered test bot, the operator's automated client and the route proxy. */
  private async startRealTelegram(): Promise<void> {
    const config = loadLiveConfig();
    const { TelegramUserPhone } = await import("../drivers/telegramUserPhone.ts");
    const phone = new TelegramUserPhone(config);
    await phone.connect();
    this.realPhone = phone;
    this.phone = phone;
    await this.connectTelegram({ upstream: REAL_TELEGRAM, token: config.testBotToken, botId: config.testBotId, forbidden: config.operatorBotId || null, useProxy: true, operatorChatId: config.operatorUserId });
  }

  private async connectTelegram(args: { upstream: string; token: string; botId: string; forbidden: string | null; useProxy: boolean; pollTimeoutSeconds?: string; operatorChatId?: string }): Promise<void> {
    const real = args.upstream === REAL_TELEGRAM;
    try {
      const identity = await preflightBot({ baseUrl: args.upstream, token: args.token, expectedBotId: args.botId, ...(args.operatorChatId === undefined ? {} : { operatorChatId: args.operatorChatId }) });
      this.telegram = { ...identity, token: args.token };
    } catch (error) {
      if (real && error instanceof PreflightError) throw new LiveSetupError(error.message);
      throw error;
    }
    if (args.useProxy) {
      this.telegramProxy = new TelegramRouteProxy(args.upstream, join(this.logsDir, "telegram-proxy.log"));
      await this.telegramProxy.listen();
    }
    appendFileSync(join(this.root, ".env"), dotenv({ TELEGRAM_BOT_TOKEN: args.token }));
    Object.assign(this.serverSpecEnv, {
      ...(this.telegramProxy ? { AGENT_CONSOLE_HARNESS_TELEGRAM_API_BASE_URL: this.telegramProxy.url } : { AGENT_CONSOLE_HARNESS_TELEGRAM_API_BASE_URL: args.upstream }),
      // A short long-poll window keeps fake-backend scenarios fast; real-backend runs keep the production 25s.
      ...(args.pollTimeoutSeconds ? { AGENT_CONSOLE_HARNESS_TELEGRAM_POLL_TIMEOUT_SECONDS: args.pollTimeoutSeconds } : {}),
      AGENT_CONSOLE_HARNESS_TEST_BOT_IDS: args.botId,
      ...(args.forbidden ? { AGENT_CONSOLE_HARNESS_FORBIDDEN_BOT_IDS: args.forbidden } : {}),
      ...this.options.serverEnv,
    });
  }

  /** The bot the harness server polls, on either backend. */
  telegramIdentity(): { id: string; username: string } {
    if (!this.telegram) throw new Error("this environment has no Telegram backend");
    return { id: this.telegram.id, username: this.telegram.username };
  }

  /** The harness bot's token, for leak assertions only. */
  telegramToken(): string {
    if (!this.telegram) throw new Error("this environment has no Telegram backend");
    return this.telegram.token;
  }

  /** Bot API calls the harness server made, by method and body: from the proxy when present, else from the fake server. */
  telegramCalls(): Array<Pick<ApiCall, "method" | "body" | "at"> | ProxiedCall> {
    if (this.telegramProxy) return this.telegramProxy.calls;
    if (this.telegramServer) return this.telegramServer.calls;
    throw new Error("this environment has no Telegram backend");
  }

  /** Cuts and restores only the harness server's route to Telegram; the phone stays connected (plan 4.2). */
  readonly network = {
    cutTelegram: (mode: RouteCut = "refuse") => this.requireProxy().cutRoute(mode),
    restoreTelegram: () => this.requireProxy().restoreRoute(),
  };

  private requireProxy(): TelegramRouteProxy {
    if (!this.telegramProxy) throw new Error("network cuts need the Telegram route proxy: set telegram.proxy (always on for the real backend)");
    return this.telegramProxy;
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

  /** Read-only query against the harness database, for durable-state assertions. */
  query<T>(sql: string, ...params: unknown[]): T[] {
    const db = new Database(join(this.root, ".agent-console/console.sqlite"), { readonly: true, fileMustExist: true });
    try {
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
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
    for (const [name, source] of [["server.log", join(this.logsDir, "server.log")], ["web.log", join(this.logsDir, "web.log")], ["web-build.log", join(this.logsDir, "web-build.log")], ["telegram-proxy.log", join(this.logsDir, "telegram-proxy.log")], ["fake-provider.log", join(this.fakeProvider.dir, "fake-provider.log")]] as const) {
      if (existsSync(source)) copyFileSync(source, join(outputDir, name));
    }
    this.databaseCopy(join(outputDir, "console.sqlite"));
  }

  /** Stops everything, then runs the end-of-run checks. Throws if any check fails. */
  async dispose(artifactDirs: string[] = []): Promise<void> {
    await this.web.stop();
    await this.server.stop();
    await this.telegramProxy?.close();
    await this.telegramServer?.close();
    await this.realPhone?.disconnect().catch(() => undefined);
    const problems: string[] = [];

    const snapshot = join(this.logsDir, "final-console.sqlite");
    this.databaseCopy(snapshot);
    const findings = sweep([this.logsDir, this.fakeProvider.dir, ...artifactDirs], this.secrets);
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
