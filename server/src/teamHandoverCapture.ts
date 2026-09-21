import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isItemId } from "./teamItems.ts";
import {
  OFFER_DEADLINE_MS,
  applyControlTransition,
  createControlRecord,
  handoverBranch,
  type ControlOutcome,
  type ControlRecord,
  type ControlRecordRemote,
} from "./teamControlRecord.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

/**
 * Capture, preview and publish: the requester's half of handover (H03, TM-T0-7).
 *
 * Capture takes a snapshot of the item's workspace through a **temporary index**,
 * so the developer's HEAD, index, worktree, branch and remote configuration are
 * untouched (protocol.md section 9, handover-rules.md 4.1). It waits until no run
 * owns the workspace, observes the tree before and after and discards a candidate
 * that moved, and stops with its own named reason on content the first release
 * cannot carry: symlinks escaping the tree, submodule contents and LFS objects.
 *
 * Secrets **warn and do not refuse**, by jd's ruling of 2026-09-20. The preview
 * lists every uncommitted file by path, flags credential shapes, and a flagged
 * match takes its own confirmation rather than riding along with the ordinary
 * Publish tap.
 *
 * Publishing order is load-bearing (protocol.md section 4): the package objects
 * are uploaded and **verified retrievable from the remote** before the control
 * record is written as `OFFERED`. A failure between the two may leave an
 * unreferenced branch, but it can never create an executable incomplete offer.
 *
 * The transition itself is H02's: `publish_offer` goes through
 * `applyControlTransition`, so the compare-and-swap, the uncertain-push
 * resolution and the epoch rules are the record's, not a second mechanism.
 */

/* ------------------------------ credentials ------------------------------- */

export type CredentialShapeId =
  | "private_key" | "aws_access_key_id" | "github_token" | "provider_api_key"
  | "telegram_bot_token" | "bearer_token" | "assigned_secret" | "credential_filename";

export interface CredentialShape {
  id: CredentialShapeId;
  label: string;
}

interface ShapeRule extends CredentialShape {
  /** Matched against file content. */
  content?: RegExp;
  /** Matched against the file's path, so an empty credential file is still flagged. */
  path?: RegExp;
}

/**
 * The shapes the preview flags. The vocabulary is deliberately the one
 * `telegramSummary.ts` already redacts from phone text, so the product has one
 * notion of what a credential looks like rather than two that drift apart.
 * tm4.md leaves the detector's choice open; this is that choice.
 */
const SHAPE_RULES: readonly ShapeRule[] = [
  { id: "private_key", label: "a private key block", content: /-----BEGIN (?:[A-Z][A-Z ]* )?PRIVATE KEY-----/ },
  { id: "aws_access_key_id", label: "an AWS access key id", content: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "github_token", label: "a GitHub token", content: /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: "provider_api_key", label: "a provider API key", content: /\b(?:sk-ant|sk|xai|glpat)[-_][A-Za-z0-9_-]{16,}\b/ },
  { id: "telegram_bot_token", label: "a Telegram bot token", content: /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/ },
  { id: "bearer_token", label: "a bearer token", content: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  // No leading word boundary: a name like TELEGRAM_TOKEN= must still match.
  { id: "assigned_secret", label: "a secret assigned to a named variable", content: /(?:api[_-]?key|secret|password|passwd|token|access[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i },
  {
    id: "credential_filename",
    label: "a filename that usually holds a credential",
    path: /(?:^|\/)(?:\.npmrc|\.netrc|id_rsa|id_ed25519|credentials)$|\.(?:env|pem|p12|pfx|key|jks)(?:\.[A-Za-z0-9]+)?$/i,
  },
];

export const CREDENTIAL_SHAPES: readonly CredentialShape[] = SHAPE_RULES.map(rule => ({ id: rule.id, label: rule.label }));

/** A package this large is called out in the one preview rather than pushed quietly. */
export const LARGE_PACKAGE_BYTES = 100 * 1024 * 1024;

/** Only the head of a file is scanned, and binary content is not scanned at all. */
const SCAN_BYTES = 256 * 1024;

export function detectCredentialShapes(content: string, path?: string): CredentialShapeId[] {
  const found: CredentialShapeId[] = [];
  for (const rule of SHAPE_RULES) {
    if (rule.content !== undefined && rule.content.test(content)) { found.push(rule.id); continue; }
    if (rule.path !== undefined && path !== undefined && rule.path.test(path)) found.push(rule.id);
  }
  return found;
}

/* -------------------------------- records --------------------------------- */

export interface CapturedFile {
  path: string;
  /** The two-character porcelain code: index letter, then worktree letter. */
  status: string;
  mode: string;
  bytes: number;
  shapes: CredentialShapeId[];
}

/**
 * The factual package of protocol.md section 9, generated without any LLM call.
 * `summary` stays null until an optional bounded read-only summary enriches it,
 * and that summary is never authoritative over the recorded decisions.
 */
export interface HandoverContext {
  version: 1;
  itemId: string;
  objective: string;
  requirements: string[];
  answers: string[];
  openQuestions: string[];
  completed: string[];
  pending: string[];
  verification: string[];
  recommendedProvider: string;
  recommendedModel: string | null;
  /** The complete working-tree and staged baseline at export, which apply compares against. */
  baseline: { head: string; staged: string[]; worktree: string[] };
  summary: string | null;
}

export type HandoverConfirmation = "credential_exposure" | "publish";

export const CAPTURE_RISK =
  "Accepted risk: a secret that reaches a shared remote stays in that remote's history, "
  + "so deleting the file afterwards does not unpublish it.";
export const CAPTURE_MITIGATION =
  "The cheap mitigation is to gitignore the file and re-capture before publishing.";

export interface CapturePreview {
  itemId: string;
  requester: string;
  provider: string;
  model: string | null;
  branch: string;
  baseCommit: string;
  snapshotCommit: string;
  packageHash: string;
  contextPath: string;
  workDirectory: string;
  /** Every uncommitted file being published, by path. */
  files: CapturedFile[];
  /** Ignored files, recorded as excluded rather than dropped silently. */
  excluded: string[];
  flagged: Array<{ path: string; shapes: CredentialShapeId[] }>;
  totalBytes: number;
  largestBytes: number;
  large: boolean;
  /** Always false: the preview warns and never refuses (jd's ruling of 2026-09-20). */
  blocked: boolean;
  requiredConfirmations: HandoverConfirmation[];
  risk: string;
  mitigation: string;
  context: HandoverContext;
  waitedForRuns: number;
}

export interface CaptureInput {
  itemId: string;
  requester: string;
  provider: string;
  model?: string | null;
  /** The record, so a local completion during capture can abandon the preparation. */
  control?: ControlRecordRemote;
  now?: Date;
  largeBytesThreshold?: number;
  idleWait?: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void> };
  /** A seam for the concurrent-editor and local-completion cases. */
  hooks?: { duringCapture?: () => void };
}

export const CONTEXT_PATH = ".agent-console/handover.json";

/* --------------------------------- plumbing -------------------------------- */

function git(cwd: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new WorkspaceError(502, "capture_git_failed", (result.stderr || result.stdout || "A Git capture operation failed.").trim());
  }
  return result.stdout;
}

function mintCommandId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/** Resolves the item, refusing a closed one: a closed item refuses every action (F02). */
function linkedItem(itemId: string) {
  if (!isItemId(itemId)) throw new WorkspaceError(422, "invalid_item", "A valid Team item id is required.");
  const link = workspaces.itemLink(itemId);
  if (link === null) throw new WorkspaceError(404, "item_not_found", "This Team item is no longer available.");
  if (link.closedAt !== null) {
    throw new WorkspaceError(409, "item_closed", "This item thread is closed, and a closed item accepts no action.", { itemId });
  }
  const home = workspaces.promptHome(link.promptId);
  const workspace = workspaces.get(home.workspaceId);
  return { link, promptId: link.promptId, workspaceId: home.workspaceId, workDirectory: workspace.workDirectory };
}

/** A run owns the workspace while an unreleased start intent holds its directory. */
function runOwnsWorkspace(workspaceId: number): boolean {
  return workspaces.activeStartIntentForWorkspace(workspaceId) !== null;
}

function completedLocally(promptId: number): boolean {
  const status = workspaces.promptOutcome(promptId).status;
  return status === "DONE" || status === "SKIPPED";
}

/* --------------------------- the unsupported scan -------------------------- */

function refuseUnsupported(reason: string, path: string, detail: string): never {
  throw new WorkspaceError(422, "unsupported_artifact", detail, { reason, path });
}

/**
 * Walks what capture would publish and stops on content the first release cannot
 * carry. The scan runs before the temporary index is built, so an unsupported
 * tree never reaches `git add` and never produces a candidate to discard.
 */
function scanCapturedTree(root: string, ignored: Set<string>): void {
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name);
      const path = relative(root, full).split("\\").join("/");
      if (entry.name === ".git") {
        if (directory === root) continue;
        refuseUnsupported("submodule_contents", relative(root, directory).split("\\").join("/"),
          "This workspace contains a nested Git repository. Submodule contents are not carried by the first handover release.");
      }
      if (ignored.has(path) || ignored.has(`${path}/`)) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(full);
        const resolved = isAbsolute(target) ? target : resolve(dirname(full), target);
        const inside = relative(root, resolved);
        if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
          refuseUnsupported("escaping_symlink", path,
            "A symlink in this workspace points outside the tree. Escaping symlinks are not carried by the first handover release.");
        }
        continue;
      }
      if (!entry.isFile()) {
        refuseUnsupported("special_file", path, "This workspace contains a file that is neither a regular file nor a symlink.");
      }
      if (path === ".gitmodules") {
        refuseUnsupported("submodule_contents", path,
          "This workspace declares submodules. Submodule contents are not carried by the first handover release.");
      }
      const head = readFileSync(full).subarray(0, SCAN_BYTES).toString("utf8");
      if (path.endsWith(".gitattributes") && /filter=lfs/.test(head)) {
        refuseUnsupported("lfs_object", path,
          "This workspace stores files in Git LFS. Required LFS objects are not carried by the first handover release, and a pointer file is not the full project.");
      }
      if (head.startsWith("version https://git-lfs.github.com/spec/v1")) {
        refuseUnsupported("lfs_object", path,
          "This file is a Git LFS pointer. The first handover release does not transfer LFS objects, and it does not pretend a pointer file is the full project.");
      }
    }
  };
  walk(root);
}

/** Splits porcelain status into the uncommitted entries and the ignored ones. */
function readStatus(root: string): { entries: Array<{ status: string; path: string }>; ignored: Set<string> } {
  const raw = git(root, ["status", "--porcelain=v1", "-z", "-uall", "--ignored=matching"]).split("\0");
  const entries: Array<{ status: string; path: string }> = [];
  const ignored = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index];
    if (line === undefined || line === "") continue;
    const status = line.slice(0, 2);
    const path = line.slice(3);
    // A rename or copy carries its origin path in the next field.
    if (status.startsWith("R") || status.startsWith("C")) index += 1;
    if (status === "!!") { ignored.add(path); continue; }
    entries.push({ status, path });
  }
  return { entries, ignored };
}

/** The whole snapshot tree, with each blob's mode and size. */
function readTreeListing(root: string, commit: string): Map<string, { mode: string; bytes: number }> {
  const listing = new Map<string, { mode: string; bytes: number }>();
  for (const line of git(root, ["ls-tree", "-r", "-l", commit]).split("\n")) {
    if (line.trim() === "") continue;
    const [meta, path] = line.split("\t");
    const parts = meta!.trim().split(/\s+/);
    listing.set(path!, { mode: parts[0]!, bytes: Number(parts[3]) });
  }
  return listing;
}

function fileShapes(root: string, path: string): CredentialShapeId[] {
  let content = "";
  try {
    const bytes = readFileSync(join(root, path)).subarray(0, SCAN_BYTES);
    // Binary content is not scanned; a NUL byte is the cheap, stable signal.
    content = bytes.includes(0) ? "" : bytes.toString("utf8");
  } catch { content = ""; }
  return detectCredentialShapes(content, path);
}

/* --------------------------------- context -------------------------------- */

function buildContext(input: {
  itemId: string; workspaceId: number; promptId: number; provider: string; model: string | null;
  head: string; staged: string[]; worktree: string[];
}): HandoverContext {
  const context = workspaces.agentContext(input.workspaceId, input.promptId);
  const remarks = context.history.remarks;
  const blocker = context.prompt.status === "BLOCKED" ? remarks.find(one => one.kind === "BLOCKER") ?? null : null;
  const text = (value: string) => value.trim();
  return {
    version: 1,
    itemId: input.itemId,
    objective: context.prompt.title,
    requirements: [context.program.overview, context.suite.overview, context.prompt.content].map(text).filter(one => one !== ""),
    answers: context.clarifications.filter(one => (one.answer ?? "") !== "").map(one => `${text(one.question)} -> ${text(one.answer ?? "")}`),
    openQuestions: [
      ...(blocker === null ? [] : [text(blocker.content)]),
      ...context.clarifications.filter(one => (one.answer ?? "") === "").map(one => text(one.question)),
    ].filter(one => one !== ""),
    completed: remarks.filter(one => one.kind === "COMPLETION" || one.kind === "PROGRESS").map(one => text(one.content)),
    pending: [
      ...remarks.filter(one => one.kind === "DECISION_NEEDED").map(one => text(one.content)),
      ...context.dependencies.filter(one => one.status !== "DONE").map(one => `Waiting on ${one.externalKey ?? one.title}`),
    ],
    verification: remarks.filter(one => one.kind === "VERIFICATION" || one.kind === "FINDING").map(one => text(one.content)),
    recommendedProvider: input.provider,
    recommendedModel: input.model,
    baseline: { head: input.head, staged: input.staged, worktree: input.worktree },
    summary: null,
  };
}

/**
 * An optional bounded read-only summary, run after capture. Its failure does not
 * invalidate captured evidence, so a rejection returns the preview unchanged.
 */
export async function attachHandoverSummary(preview: CapturePreview, summarize: () => Promise<string>): Promise<CapturePreview> {
  try {
    const summary = (await summarize()).trim();
    if (summary === "") return preview;
    return { ...preview, context: { ...preview.context, summary } };
  } catch {
    return preview;
  }
}

/* --------------------------------- trigger --------------------------------- */

/**
 * Step 1 of teammate-design.md section 5.4: hold the item, move the record to
 * `PREPARING`, and end the grants that existed on it, because grants end when
 * handover starts. A refused start ends no grant.
 */
export async function beginHandover(
  remote: ControlRecordRemote,
  input: { itemId: string; requester: string; commandId: string; now?: Date; workstationId?: string },
): Promise<ControlOutcome> {
  linkedItem(input.itemId);
  if (await remote.read() === null) {
    await createControlRecord(remote, {
      itemId: input.itemId, requester: input.requester,
      commandId: `${input.commandId}-create`, now: input.now, workstationId: input.workstationId,
    });
  }
  const current = await remote.read();
  if (current === null) throw new WorkspaceError(503, "control_unreachable", "Waiting for the item control record to become readable.");
  const outcome = await applyControlTransition(remote, {
    event: "request_takeover",
    actor: { personId: input.requester, workstationId: input.workstationId },
    commandId: input.commandId,
    epoch: current.record.epoch,
    now: input.now,
    fromHead: current.head,
    // The requester's pipeline and workspace hold is persisted by the trigger
    // card before this is called; H05 is what releases it.
    payload: { sourceHoldPersisted: true },
  });
  workspaces.revokeItemGrants({ itemId: input.itemId, commandId: input.commandId });
  return outcome;
}

/* --------------------------------- capture -------------------------------- */

async function abandonPreparation(input: CaptureInput, requester: string): Promise<never> {
  const control = input.control;
  if (control !== undefined) {
    const current = await control.read();
    if (current !== null && current.record.state === "PREPARING") {
      await applyControlTransition(control, {
        event: "abandon_preparation",
        actor: { personId: requester },
        commandId: mintCommandId("abandon"),
        epoch: current.record.epoch,
        now: input.now,
        fromHead: current.head,
      });
    }
  }
  throw new WorkspaceError(409, "handover_abandoned",
    "This task completed locally during capture, so the handover is abandoned. Completion revokes grants and ends the item; there is nothing left to hand over.");
}

export async function captureHandoverPackage(input: CaptureInput): Promise<CapturePreview> {
  const { promptId, workspaceId, workDirectory } = linkedItem(input.itemId);
  const model = input.model ?? null;

  // Capture waits until no run owns the workspace; it never snapshots a moving tree.
  const wait = input.idleWait ?? { attempts: 60, delayMs: 5_000 };
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>(done => { setTimeout(done, ms); }));
  let waitedForRuns = 0;
  while (runOwnsWorkspace(workspaceId)) {
    if (waitedForRuns >= wait.attempts) {
      throw new WorkspaceError(409, "workspace_busy",
        "A run still owns this workspace. Capture waits rather than snapshotting a moving tree; stop the run and try again.");
    }
    await sleep(wait.delayMs);
    waitedForRuns += 1;
  }

  if (completedLocally(promptId)) await abandonPreparation(input, input.requester);

  const root = git(workDirectory, ["rev-parse", "--show-toplevel"]).trim();
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const observe = () => git(root, ["status", "--porcelain=v1", "-z", "-uall"]);
  const before = observe();
  const { entries, ignored } = readStatus(root);
  scanCapturedTree(root, ignored);

  const staged = git(root, ["diff", "--cached", "--name-only", "HEAD"]).split("\n").filter(one => one !== "");
  const worktree = [...new Set(entries.filter(one => one.status !== "!!").map(one => one.path))].sort();
  const context = buildContext({ itemId: input.itemId, workspaceId, promptId, provider: input.provider, model, head, staged, worktree });

  // The snapshot goes through a temporary index, so HEAD, the index, the
  // worktree, the developer's branch and their remote configuration are untouched.
  const indexDirectory = mkdtempSync(join(tmpdir(), "aw-handover-index-"));
  let snapshotCommit: string;
  let packageHash: string;
  try {
    const env = { GIT_INDEX_FILE: join(indexDirectory, "index") };
    git(root, ["read-tree", "--empty"], { env });
    git(root, ["add", "-A", "--", "."], { env });
    for (const line of git(root, ["ls-files", "--stage"], { env }).split("\n")) {
      if (line.startsWith("160000 ")) {
        refuseUnsupported("submodule_contents", line.split("\t")[1] ?? "",
          "This workspace records a submodule. Submodule contents are not carried by the first handover release.");
      }
    }
    const contextBlob = git(root, ["hash-object", "-w", "--stdin"], { input: JSON.stringify(context) }).trim();
    git(root, ["update-index", "--add", "--cacheinfo", `100644,${contextBlob},${CONTEXT_PATH}`], { env });
    const tree = git(root, ["write-tree"], { env }).trim();
    packageHash = `sha1:${tree}`;
    snapshotCommit = git(root, [
      "commit-tree", tree, "-p", head,
      "-m", `Handover snapshot for ${input.itemId}`,
    ], {
      env: {
        ...env,
        GIT_AUTHOR_NAME: "agent-console", GIT_AUTHOR_EMAIL: "agent-console@invalid",
        GIT_COMMITTER_NAME: "agent-console", GIT_COMMITTER_EMAIL: "agent-console@invalid",
      },
    }).trim();
  } finally {
    rmSync(indexDirectory, { recursive: true, force: true });
  }

  input.hooks?.duringCapture?.();

  // A task that completes locally during capture abandons the handover.
  if (completedLocally(promptId)) await abandonPreparation(input, input.requester);
  // The tree is observed before and after; a change during capture discards the
  // candidate rather than publishing a torn snapshot. The candidate commit stays
  // unreferenced and is never pushed.
  if (observe() !== before) {
    throw new WorkspaceError(409, "capture_torn",
      "The workspace changed while it was being captured, so this snapshot was discarded. Stop editing and capture again.");
  }

  const listing = readTreeListing(root, snapshotCommit);
  const files: CapturedFile[] = entries.map(entry => {
    const blob = listing.get(entry.path);
    return {
      path: entry.path,
      status: entry.status,
      mode: blob?.mode ?? "000000",
      bytes: blob?.bytes ?? 0,
      shapes: blob === undefined ? [] : fileShapes(root, entry.path),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));

  const flagged = files.filter(one => one.shapes.length > 0).map(one => ({ path: one.path, shapes: one.shapes }));
  let totalBytes = 0;
  let largestBytes = 0;
  for (const blob of listing.values()) { totalBytes += blob.bytes; largestBytes = Math.max(largestBytes, blob.bytes); }

  return {
    itemId: input.itemId,
    requester: input.requester,
    provider: input.provider,
    model,
    branch: handoverBranch(input.itemId),
    baseCommit: head,
    snapshotCommit,
    packageHash,
    contextPath: CONTEXT_PATH,
    workDirectory: root,
    files,
    excluded: [...ignored].sort(),
    flagged,
    totalBytes,
    largestBytes,
    large: totalBytes >= (input.largeBytesThreshold ?? LARGE_PACKAGE_BYTES),
    blocked: false,
    // A flagged match takes its own confirmation rather than riding along with
    // the ordinary Publish tap, so proceeding is always deliberate. The size
    // confirmation is folded into that one Publish tap.
    requiredConfirmations: flagged.length > 0 ? ["credential_exposure", "publish"] : ["publish"],
    risk: CAPTURE_RISK,
    mitigation: CAPTURE_MITIGATION,
    context,
    waitedForRuns,
  };
}

/* --------------------------------- publish -------------------------------- */

export interface HandoverPackageRemote {
  /** Uploads the package objects. "uncertain" means the outcome is unknown. */
  publish(commit: string, branch: string): Promise<"published" | "uncertain">;
  /** Reads the objects back out of the remote; false when they are not retrievable. */
  verify(commit: string, branch: string): Promise<boolean>;
}

/**
 * A bare-repository seam for `refs/heads/aw/handover/<item>`. The push names an
 * explicit URL and an explicit refspec and carries no force flag, so it creates
 * no local branch and changes neither the developer's branch nor their remote
 * configuration.
 */
export class BareGitHandoverPackageRemote implements HandoverPackageRemote {
  constructor(private readonly sourceDirectory: string, private readonly bareDirectory: string) {}

  async publish(commit: string, branch: string): Promise<"published" | "uncertain"> {
    const pushed = spawnSync("git", ["push", this.bareDirectory, `${commit}:refs/heads/${branch}`], {
      cwd: this.sourceDirectory, encoding: "utf8",
    });
    if (pushed.status === 0) return "published";
    // A rejection leaves the outcome unknown from here; verification is what
    // settles it, and it runs before anything is offered either way.
    if (/rejected|non-fast-forward|fetch first/i.test(pushed.stderr ?? "")) return "uncertain";
    throw new WorkspaceError(502, "handover_push_failed", (pushed.stderr || "Could not publish the handover package.").trim());
  }

  /** Reads the ref and every reachable object back out of the remote. */
  async verify(commit: string, branch: string): Promise<boolean> {
    const ref = spawnSync("git", ["--git-dir", this.bareDirectory, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" });
    if (ref.status !== 0 || ref.stdout.trim() !== commit) return false;
    const objects = spawnSync("git", ["--git-dir", this.bareDirectory, "rev-list", "--objects", commit], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (objects.status !== 0) return false;
    const ids = objects.stdout.split("\n").map(line => line.split(" ")[0]).filter(one => one !== undefined && one !== "");
    if (ids.length === 0) return false;
    const checked = spawnSync("git", ["--git-dir", this.bareDirectory, "cat-file", "--batch-check"], {
      encoding: "utf8", input: `${ids.join("\n")}\n`, maxBuffer: 64 * 1024 * 1024,
    });
    return checked.status === 0 && !/missing|ambiguous/.test(checked.stdout);
  }
}

export interface PublishedOffer {
  itemId: string;
  branch: string;
  snapshotCommit: string;
  packageHash: string;
  provider: string;
  model: string | null;
  /**
   * The rest of the requested capabilities the receiver compares against its own
   * settings (design 5.4 step 4). `null` is "not stated by this offer", which
   * RTC-12 treats as unknown rather than as permission.
   */
  hostAccess: boolean | null;
  sandbox: string | null;
  tools: string[] | null;
  /** The offer is an open call: it names no receiver (ruled 2026-09-20). */
  receiver: null;
  epoch: number;
  startDeadline: string;
}

export interface PublishInput {
  preview: CapturePreview;
  control: ControlRecordRemote;
  packages: HandoverPackageRemote;
  commandId: string;
  actor: { personId: string; workstationId?: string };
  confirmations: HandoverConfirmation[];
  acknowledgedBytes: number;
  /** What the package needs beyond a provider and a model, recorded in the offer. */
  requested?: { hostAccess?: boolean; sandbox?: string; tools?: string[] };
  now?: Date;
}

/**
 * Step 3 of teammate-design.md section 5.4, in protocol.md section 4's order.
 * Nothing is pushed until every confirmation the preview asked for is in hand,
 * and the record is not written until the pushed objects have been read back
 * from the remote.
 */
export async function publishHandoverOffer(input: PublishInput): Promise<{ outcome: ControlOutcome; offer: PublishedOffer }> {
  const preview = input.preview;
  linkedItem(preview.itemId);

  if (!input.confirmations.includes("publish")) {
    throw new WorkspaceError(428, "publish_unconfirmed", "This offer has not been confirmed for publishing.");
  }
  if (input.acknowledgedBytes !== preview.totalBytes) {
    throw new WorkspaceError(428, "size_unconfirmed",
      `This package is ${preview.totalBytes} bytes, which is not the size that was confirmed. Review the preview and confirm again.`,
      { previewBytes: String(preview.totalBytes), acknowledgedBytes: String(input.acknowledgedBytes) });
  }
  if (preview.flagged.length > 0 && !input.confirmations.includes("credential_exposure")) {
    throw new WorkspaceError(428, "credential_confirmation_required",
      `${preview.flagged.length} file(s) match a known credential shape. ${CAPTURE_RISK} ${CAPTURE_MITIGATION} Confirm the exposure separately to publish them anyway.`,
      { paths: preview.flagged.map(one => one.path).join(",") });
  }

  // Upload the immutable package objects first, and verify they are retrievable
  // from the remote. Only then publish OFFERED referencing them.
  await input.packages.publish(preview.snapshotCommit, preview.branch);
  if (!await input.packages.verify(preview.snapshotCommit, preview.branch)) {
    throw new WorkspaceError(502, "package_not_retrievable",
      "The handover package is not retrievable from the remote, so no offer was published.");
  }

  const current = await input.control.read();
  if (current === null) throw new WorkspaceError(404, "control_not_found", "This item has no control record yet.");
  const now = input.now ?? new Date();
  const outcome = await applyControlTransition(input.control, {
    event: "publish_offer",
    actor: input.actor,
    commandId: input.commandId,
    epoch: current.record.epoch,
    now,
    fromHead: current.head,
    payload: {
      writersStopped: true,
      packageVerified: true,
      branchVerified: true,
      offerDeadline: new Date(now.getTime() + OFFER_DEADLINE_MS).toISOString(),
      requestedProvider: preview.provider,
      requestedModel: preview.model,
      packageHash: preview.packageHash,
      snapshotCommit: preview.snapshotCommit,
      ...(input.requested?.hostAccess === undefined ? {} : { requestedHostAccess: input.requested.hostAccess }),
      ...(input.requested?.sandbox === undefined ? {} : { requestedSandbox: input.requested.sandbox }),
      ...(input.requested?.tools === undefined ? {} : { requestedTools: input.requested.tools }),
    },
  });
  const offer = offerFrom(outcome.record, outcome.event.payload);
  if (offer === null) throw new WorkspaceError(502, "offer_incomplete", "The published offer is incomplete.");
  return { outcome, offer };
}

function offerFrom(record: ControlRecord, payload: {
  requestedProvider?: string; requestedModel?: string | null; packageHash?: string; snapshotCommit?: string;
  requestedHostAccess?: boolean; requestedSandbox?: string; requestedTools?: string[];
}): PublishedOffer | null {
  if (record.state !== "OFFERED" || record.offerDeadline === null) return null;
  if (payload.requestedProvider === undefined || payload.snapshotCommit === undefined || payload.packageHash === undefined) return null;
  return {
    itemId: record.itemId,
    branch: record.branch,
    snapshotCommit: payload.snapshotCommit,
    packageHash: payload.packageHash,
    provider: payload.requestedProvider,
    model: payload.requestedModel ?? null,
    hostAccess: payload.requestedHostAccess ?? null,
    sandbox: payload.requestedSandbox ?? null,
    tools: payload.requestedTools ?? null,
    receiver: null,
    epoch: record.epoch,
    startDeadline: record.offerDeadline,
  };
}

/**
 * Rebuilds the Offer record a teammate discovers, from the record's current
 * state and the event that published it. Returns null when the item is not
 * currently offering anything.
 */
export async function readPublishedOffer(record: ControlRecord, remote: ControlRecordRemote): Promise<PublishedOffer | null> {
  if (record.state !== "OFFERED" || record.lastCommandId === null) return null;
  const event = await remote.readEvent(record.lastCommandId);
  if (event === null || event.toState !== "OFFERED") return null;
  return offerFrom(record, event.payload);
}
