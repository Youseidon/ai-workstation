import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { HarnessEnvironment, SERVER_PORT, WEB_PORT, type EnvironmentOptions } from "./orchestrator.ts";
import { isPortOpen } from "./processes.ts";
import { FakeTelegramServer, type FakeBot, type FakeChat, type FakeUser } from "../fakes/telegramServer.ts";

export interface TeamHarnessOptions {
  envA?: Omit<EnvironmentOptions, "portOffset" | "telegram">;
  envB?: Omit<EnvironmentOptions, "portOffset" | "telegram">;
  portOffsetA?: number;
  portOffsetB?: number;
}

export interface TeamHarnessMember {
  readonly name: "A" | "B";
  readonly app: HarnessEnvironment;
  readonly bot: FakeBot;
  readonly user: FakeUser;
  readonly privateChat: FakeChat;
  readonly git: TeamGitClient;
}

export interface TeamHarness {
  readonly root: string;
  readonly fakeTelegram: FakeTelegramServer;
  readonly bareRepository: string;
  readonly groupChat: FakeChat;
  readonly envA: TeamHarnessMember;
  readonly envB: TeamHarnessMember;
  dispose(): Promise<void>;
}

export class TeamGitClient {
  private cut = false;

  constructor(
    readonly name: string,
    readonly workspace: string,
    private readonly homeDir: string,
  ) {}

  cutGit(): void {
    this.cut = true;
  }

  restoreGit(): void {
    this.cut = false;
  }

  commitFile(path: string, content: string, message = `commit ${path}`): void {
    writeFileSync(join(this.workspace, path), content);
    this.git("add", path);
    this.git("commit", "-q", "-m", message);
  }

  push(ref = "refs/heads/main"): void {
    this.git("push", "-q", "origin", `HEAD:${ref}`);
  }

  fetch(ref = "refs/heads/main"): void {
    this.git("fetch", "-q", "origin", ref);
  }

  revParse(ref: string): string {
    return this.git("rev-parse", ref).stdout.trim();
  }

  private git(...args: string[]): { stdout: string; stderr: string } {
    if (this.cut && ["fetch", "pull", "push", "ls-remote"].includes(args[0] ?? "")) {
      throw new Error(`harness network: git is cut for env ${this.name}`);
    }
    const result = spawnSync("git", args, {
      cwd: this.workspace,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: this.homeDir,
        GIT_AUTHOR_NAME: `harness-${this.name}`,
        GIT_AUTHOR_EMAIL: `harness-${this.name}@example.invalid`,
        GIT_COMMITTER_NAME: `harness-${this.name}`,
        GIT_COMMITTER_EMAIL: `harness-${this.name}@example.invalid`,
      },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed for env ${this.name}: ${result.stderr || result.stdout}`);
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

export async function startTeamHarness(options: TeamHarnessOptions = {}): Promise<TeamHarness> {
  const [portOffsetA, portOffsetB] = await choosePortOffsets(options);
  const root = mkdtempSync(join(tmpdir(), "ai-workstation-team-e2e-"));
  const fakeTelegram = new FakeTelegramServer();
  await fakeTelegram.listen();
  const bareRepository = join(root, "shared.git");
  runGit(root, "init", "--bare", "-q", bareRepository);

  const botA = fakeBot(710_000_001, "harness_bot_a");
  const botB = fakeBot(710_000_002, "harness_bot_b");
  fakeTelegram.addBot(botA);
  fakeTelegram.addBot(botB);

  const userA: FakeUser = { id: 5_550_101, firstName: "Team A", username: "team_a" };
  const userB: FakeUser = { id: 5_550_202, firstName: "Team B", username: "team_b" };
  const privateChatA: FakeChat & { type: "private" } = { id: userA.id, type: "private" };
  const privateChatB: FakeChat & { type: "private" } = { id: userB.id, type: "private" };
  const groupChat: FakeChat = { id: -100_555_000_333, type: "supergroup", title: "Harness team" };
  fakeTelegram.registerChat(groupChat);

  const appA = new HarnessEnvironment({
    ...options.envA,
    portOffset: portOffsetA,
    telegram: { backend: "fake", sharedFake: { server: fakeTelegram, bot: botA, user: userA, chat: privateChatA } },
  });
  const appB = new HarnessEnvironment({
    ...options.envB,
    portOffset: portOffsetB,
    telegram: { backend: "fake", sharedFake: { server: fakeTelegram, bot: botB, user: userB, chat: privateChatB } },
  });

  let startedA = false;
  let startedB = false;
  try {
    await appA.start();
    startedA = true;
    await appB.start();
    startedB = true;
    const gitA = createWorkingClone(root, "A", bareRepository, appA.homeDir);
    const gitB = createWorkingClone(root, "B", bareRepository, appB.homeDir);
    return {
      root,
      fakeTelegram,
      bareRepository,
      groupChat,
      envA: { name: "A", app: appA, bot: botA, user: userA, privateChat: privateChatA, git: gitA },
      envB: { name: "B", app: appB, bot: botB, user: userB, privateChat: privateChatB, git: gitB },
      async dispose() {
        await disposeAll(appB, appA);
        await fakeTelegram.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (startedB) await appB.dispose().catch(() => undefined);
    if (startedA) await appA.dispose().catch(() => undefined);
    await fakeTelegram.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function choosePortOffsets(options: TeamHarnessOptions): Promise<[number, number]> {
  if (options.portOffsetA !== undefined && options.portOffsetB !== undefined) {
    if (options.portOffsetA === options.portOffsetB) throw new Error("team harness port offsets must differ");
    return [options.portOffsetA, options.portOffsetB];
  }
  const offsets: number[] = [];
  for (let offset = 20; offset < 120 && offsets.length < 2; offset++) {
    if (offset === options.portOffsetA || offset === options.portOffsetB) continue;
    if (!(await isPortOpen(SERVER_PORT + offset)) && !(await isPortOpen(WEB_PORT + offset))) offsets.push(offset);
  }
  if (options.portOffsetA !== undefined) return [options.portOffsetA, offsets[0] ?? failNoOffsets()];
  if (options.portOffsetB !== undefined) return [offsets[0] ?? failNoOffsets(), options.portOffsetB];
  if (offsets.length < 2) failNoOffsets();
  return [offsets[0]!, offsets[1]!];
}

function failNoOffsets(): never {
  throw new Error("team harness could not find two free app port offsets");
}

function fakeBot(id: number, username: string): FakeBot {
  return { id, username, token: `${id}:${randomBytes(27).toString("base64url")}` };
}

function createWorkingClone(root: string, name: string, bareRepository: string, homeDir: string): TeamGitClient {
  const workspace = join(root, `env-${name}`);
  mkdirSync(workspace, { recursive: true });
  runGit(workspace, "init", "-q", "-b", "main");
  runGit(workspace, "remote", "add", "origin", bareRepository);
  writeFileSync(join(workspace, "README.md"), `# env ${name}\n`);
  const client = new TeamGitClient(name, workspace, homeDir);
  client.commitFile("README.md", `# env ${name}\n`, "initial fixture");
  return client;
}

function runGit(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: "harness",
      GIT_AUTHOR_EMAIL: "harness@example.invalid",
      GIT_COMMITTER_NAME: "harness",
      GIT_COMMITTER_EMAIL: "harness@example.invalid",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function disposeAll(...apps: HarnessEnvironment[]): Promise<void> {
  const errors: unknown[] = [];
  for (const app of apps) {
    try {
      await app.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}
