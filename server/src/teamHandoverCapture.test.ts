import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { config } from "./config.ts";
import { settings } from "./settings.ts";
import {
  BareGitControlRecordRemote,
  applyControlTransition,
  controlRef,
  handoverBranch,
  type ControlEvent,
  type ControlRecord,
  type ControlRecordRemote,
  type ControlSnapshot,
} from "./teamControlRecord.ts";
import {
  CREDENTIAL_SHAPES,
  type CredentialShapeId,
  LARGE_PACKAGE_BYTES,
  attachHandoverSummary,
  beginHandover,
  captureHandoverPackage,
  detectCredentialShapes,
  publishHandoverOffer,
  readPublishedOffer,
  BareGitHandoverPackageRemote,
  type CapturePreview,
  type HandoverPackageRemote,
} from "./teamHandoverCapture.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

// Scenario TM-T0-7, docs/e2e-scenarios/tm4.md: capture, preview and publish.

const REQUESTER = "jd";
const RECEIVER = "yousef";
const PROVIDER = "claude";
const MODEL = "sonnet";

/**
 * Credential-shaped fixtures are assembled from parts so no whole token shape is
 * a literal in this file, and every body is the word EXAMPLE repeated. The
 * changed-file credential sweep therefore still means something over this diff:
 * it finds no complete shape here, and what it would find is visibly synthetic.
 */
const EXAMPLE = "EXAMPLEEXAMPLEEXAMPLE";
const fake = (prefix: string, body: string) => `${prefix}${body}`;
/** A PEM header with no key material, assembled so the sweep finds no whole shape. */
const pem = (kind: string) => `${"-".repeat(5)}BEGIN ${kind} PRIVATE KEY${"-".repeat(5)}`;

const database = () => new Database(join(config.repoRoot, ".agent-console/console.sqlite"));

function git(directory: string, args: string[], input?: string) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", input }).trim();
}

function bareRepository(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--bare", "-q", directory]);
  return directory;
}

/** Every regular file under the tree, with its mode and content hash. */
function worktreeFingerprint(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const full = join(directory, entry.name);
      const path = relative(root, full);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.isSymbolicLink()) { out.push(`${path} symlink`); continue; }
      const stat = statSync(full);
      out.push(`${path} ${(stat.mode & 0o777).toString(8)} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(root);
  return out;
}

/** HEAD, the index bytes, the worktree, the branch and the remote configuration. */
function developerState(directory: string) {
  git(directory, ["status", "--porcelain=v1"]);
  return {
    head: git(directory, ["rev-parse", "HEAD"]),
    branch: git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
    refs: git(directory, ["show-ref"]),
    remotes: spawnSync("git", ["remote", "-v"], { cwd: directory, encoding: "utf8" }).stdout,
    index: createHash("sha256").update(readFileSync(join(directory, ".git/index"))).digest("hex"),
    worktree: worktreeFingerprint(directory),
    status: git(directory, ["status", "--porcelain=v1", "-uall"]),
  };
}

interface Fixture {
  workspaceId: number;
  promptId: number;
  itemId: string;
  directory: string;
  bare: string;
  control: BareGitControlRecordRemote;
  packages: BareGitHandoverPackageRemote;
  dispose(): void;
}

/**
 * A linked item on workstation A whose workspace carries staged changes,
 * unstaged changes to tracked files, untracked non-ignored files and an ignored
 * file, plus a shared bare repository standing in for the private remote.
 */
function fixture(prefix: string, build?: (directory: string) => void): Fixture {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-ws-`));
  const bare = bareRepository(`${prefix}-bare-`);
  git(directory, ["init", "-q", "-b", "work"]);
  git(directory, ["config", "user.email", "jd@invalid"]);
  git(directory, ["config", "user.name", "jd"]);
  writeFileSync(join(directory, "tracked.txt"), "committed\n");
  writeFileSync(join(directory, "staged.txt"), "committed\n");
  writeFileSync(join(directory, ".gitignore"), "ignored.log\n");
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-q", "-m", "base"]);

  writeFileSync(join(directory, "tracked.txt"), "worktree edit\n");
  writeFileSync(join(directory, "staged.txt"), "staged edit\n");
  git(directory, ["add", "staged.txt"]);
  writeFileSync(join(directory, "untracked.txt"), "new work\n");
  writeFileSync(join(directory, "ignored.log"), "noise\n");
  mkdirSync(join(directory, "tools"), { recursive: true });
  writeFileSync(join(directory, "tools/run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(directory, "tools/run.sh"), 0o755);
  symlinkSync("tracked.txt", join(directory, "inside.txt"));
  build?.(directory);

  const workspace = workspaces.create({ name: directory, workDirectory: directory });
  const program = workspaces.createChild("program", workspace.id, { name: "Program", overview: "Ship handover" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite", overview: "TM4" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Finish the capture", content: "Capture and offer the item" }) as PromptRecord;
  const link = workspaces.createItemLink({ promptId: prompt.id, role: "requester", epoch: 1 });
  return {
    workspaceId: workspace.id,
    promptId: prompt.id,
    itemId: link.itemId,
    directory,
    bare,
    control: new BareGitControlRecordRemote(bare, link.itemId),
    packages: new BareGitHandoverPackageRemote(directory, bare),
    dispose() {
      workspaces.remove(workspace.id);
      rmSync(directory, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    },
  };
}

const capture = (f: Fixture, extra: Record<string, unknown> = {}) => captureHandoverPackage({
  itemId: f.itemId, requester: REQUESTER, provider: PROVIDER, model: MODEL, control: f.control, ...extra,
});

async function prepared(f: Fixture, commandId = "begin-1") {
  return beginHandover(f.control, { itemId: f.itemId, requester: REQUESTER, commandId });
}

const publish = (f: Fixture, preview: CapturePreview, extra: Record<string, unknown> = {}) => publishHandoverOffer({
  preview,
  control: f.control,
  packages: f.packages,
  commandId: "publish-1",
  actor: { personId: REQUESTER },
  confirmations: ["publish"],
  acknowledgedBytes: preview.totalBytes,
  ...extra,
});

/** Wraps both remotes so the order of the publication protocol's steps is observable. */
function recorder(control: ControlRecordRemote, packages: HandoverPackageRemote, calls: string[]) {
  return {
    control: {
      read: async (): Promise<ControlSnapshot | null> => { calls.push("control.read"); return control.read(); },
      readEvent: async (id: string): Promise<ControlEvent | null> => { calls.push("control.readEvent"); return control.readEvent(id); },
      append: async (head: string | null, record: ControlRecord, event: ControlEvent) => { calls.push("control.append"); return control.append(head, record, event); },
    } satisfies ControlRecordRemote,
    packages: {
      publish: async (commit: string, branch: string) => { calls.push("package.publish"); return packages.publish(commit, branch); },
      verify: async (commit: string, branch: string) => { calls.push("package.verify"); return packages.verify(commit, branch); },
    } satisfies HandoverPackageRemote,
  };
}

function branchExists(bare: string, itemId: string) {
  return spawnSync("git", ["--git-dir", bare, "rev-parse", "--verify", "-q", `refs/heads/${handoverBranch(itemId)}`]).status === 0;
}

test("TM-T0-7: capture, preview and publish", async (t) => {
  await t.test("Capture: HEAD, the index and the worktree are byte-identical, and the snapshot is the tree", async () => {
    const f = fixture("tm-t0-7-snapshot");
    try {
      await prepared(f);
      const before = developerState(f.directory);
      const preview = await capture(f);
      const after = developerState(f.directory);
      assert.deepEqual(after, before, "HEAD, the index, the worktree, the branch and the remotes are untouched");
      assert.equal(preview.baseCommit, before.head);
      assert.equal(preview.branch, handoverBranch(f.itemId));
      assert.equal(after.refs.includes(handoverBranch(f.itemId)), false, "capture creates no local branch");

      const tree = Object.fromEntries(git(f.directory, ["ls-tree", "-r", preview.snapshotCommit])
        .split("\n").map(line => { const [meta, path] = line.split("\t"); const [mode, , oid] = meta!.split(" "); return [path!, { mode: mode!, oid: oid! }]; }));
      const blob = (path: string) => git(f.directory, ["cat-file", "blob", tree[path]!.oid]);
      assert.equal(blob("tracked.txt"), "worktree edit", "the snapshot carries the working tree, not HEAD");
      assert.equal(blob("staged.txt"), "staged edit");
      assert.equal(blob("untracked.txt"), "new work", "untracked non-ignored files are captured");
      assert.equal(tree["ignored.log"], undefined, "ignored files are excluded");
      assert.equal(tree["tools/run.sh"]!.mode, "100755", "executable bits survive");
      assert.equal(tree["inside.txt"]!.mode, "120000", "a safe internal symlink is supported");
      assert.equal(tree[preview.contextPath] !== undefined, true, "the context file is part of the snapshot");
      assert.equal(git(f.directory, ["rev-list", "--count", preview.snapshotCommit]), "2", "one snapshot commit on top of the base");
      assert.equal(git(f.directory, ["rev-parse", `${preview.snapshotCommit}^`]), before.head, "its single parent is the developer's HEAD");
      assert.deepEqual(preview.excluded, ["ignored.log"], "excluded files are recorded rather than dropped silently");
    } finally { f.dispose(); }
  });

  await t.test("Capture: the tree is observed before and after, and a change during it discards the candidate", async () => {
    const f = fixture("tm-t0-7-torn");
    try {
      await prepared(f);
      const before = developerState(f.directory);
      await assert.rejects(
        () => capture(f, { hooks: { duringCapture: () => writeFileSync(join(f.directory, "moving.txt"), "still typing\n") } }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "capture_torn",
        "a tree that moved during capture is discarded rather than published",
      );
      assert.equal(branchExists(f.bare, f.itemId), false, "a torn candidate publishes nothing");
      assert.equal((await f.control.read())!.record.state, "PREPARING", "and advances no state");
      assert.equal(developerState(f.directory).index, before.index, "and still leaves the index alone");
    } finally { f.dispose(); }
  });

  await t.test("Capture: waits while a run owns the workspace, and refuses when it never lets go", async () => {
    const f = fixture("tm-t0-7-busy");
    try {
      await prepared(f);
      const runId = `tm-t0-7-run-${f.workspaceId}`;
      workspaces.reserveStartIntent({ runId, workspaceId: f.workspaceId, promptId: f.promptId, provider: PROVIDER, model: MODEL, source: "test" });
      let waits = 0;
      const preview = await capture(f, {
        idleWait: {
          attempts: 5,
          delayMs: 1,
          sleep: async () => { waits += 1; if (waits === 2) workspaces.markStartIntent(runId, "KNOWN_STOPPED"); },
        },
      });
      assert.equal(waits >= 2, true, "capture waited rather than snapshotting a moving tree");
      assert.equal(preview.waitedForRuns, waits);

      const second = `${runId}-b`;
      workspaces.reserveStartIntent({ runId: second, workspaceId: f.workspaceId, promptId: f.promptId, provider: PROVIDER, model: MODEL, source: "test" });
      await assert.rejects(
        () => capture(f, { idleWait: { attempts: 2, delayMs: 1, sleep: async () => {} } }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "workspace_busy",
        "a run that never releases the workspace stops the capture",
      );
      workspaces.markStartIntent(second, "KNOWN_STOPPED");
    } finally { f.dispose(); }
  });

  await t.test("Refusals: unsupported content stops the capture with its own named reason and publishes nothing", async () => {
    const cases: Array<{ name: string; reason: string; build: (directory: string) => void }> = [
      { name: "escaping symlink", reason: "escaping_symlink", build: directory => symlinkSync("../escape-target", join(directory, "escape.txt")) },
      { name: "absolute symlink", reason: "escaping_symlink", build: directory => symlinkSync("/etc/hostname", join(directory, "absolute.txt")) },
      {
        name: "submodule contents",
        reason: "submodule_contents",
        build: directory => { mkdirSync(join(directory, "vendor/lib"), { recursive: true }); execFileSync("git", ["init", "-q", join(directory, "vendor/lib")]); },
      },
      {
        name: "declared submodule",
        reason: "submodule_contents",
        build: directory => writeFileSync(join(directory, ".gitmodules"), '[submodule "lib"]\n\tpath = lib\n\turl = https://example.invalid/lib.git\n'),
      },
      {
        name: "LFS pointer",
        reason: "lfs_object",
        build: directory => writeFileSync(join(directory, "big.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 12345\n"),
      },
      {
        name: "LFS filter",
        reason: "lfs_object",
        build: directory => writeFileSync(join(directory, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n"),
      },
    ];
    for (const one of cases) {
      const f = fixture("tm-t0-7-unsupported", one.build);
      try {
        await prepared(f);
        await assert.rejects(
          () => capture(f),
          (error: unknown) => error instanceof WorkspaceError
            && error.code === "unsupported_artifact"
            && error.fields?.reason === one.reason
            && typeof error.fields?.path === "string",
          `${one.name} stops the capture as ${one.reason}`,
        );
        assert.equal(branchExists(f.bare, f.itemId), false, `${one.name} publishes nothing`);
        assert.equal((await f.control.read())!.record.state, "PREPARING");
      } finally { f.dispose(); }
    }
  });

  await t.test("Refusals: a closed item refuses the handover outright, at every step", async () => {
    const f = fixture("tm-t0-7-closed");
    try {
      const started = await prepared(f);
      const preview = await capture(f);
      workspaces.closeItemLink({ itemId: f.itemId, commandId: "close-1" });
      const closed = (error: unknown) => error instanceof WorkspaceError && error.code === "item_closed";
      await assert.rejects(() => beginHandover(f.control, { itemId: f.itemId, requester: REQUESTER, commandId: "begin-closed" }), closed, "a closed item starts no handover");
      await assert.rejects(() => capture(f), closed, "a closed item captures nothing");
      await assert.rejects(() => publish(f, preview), closed, "a closed item publishes no offer");
      assert.equal(branchExists(f.bare, f.itemId), false);
      assert.equal((await f.control.read())!.record.state, started.record.state, "and the record does not move");
    } finally { f.dispose(); }
  });

  await t.test("Refusals: a task that completes locally during capture abandons the handover and says so", async () => {
    const f = fixture("tm-t0-7-completed");
    try {
      await prepared(f);
      await assert.rejects(
        () => capture(f, {
          hooks: {
            duringCapture: () => {
              const db = database();
              try { db.prepare("UPDATE prompt SET status='DONE',result='done',completed_at=? WHERE id=?").run(new Date().toISOString(), f.promptId); } finally { db.close(); }
            },
          },
        }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "handover_abandoned" && /complet/i.test(error.message),
        "completion ends the item, so there is nothing left to hand over",
      );
      assert.equal((await f.control.read())!.record.state, "LOCAL", "the abandoned preparation returns the record to LOCAL");
      assert.equal(branchExists(f.bare, f.itemId), false);
    } finally { f.dispose(); }
  });

  await t.test("Preview: every uncommitted file by path, flagged shapes, the size, the accepted risk and the mitigation", async () => {
    const f = fixture("tm-t0-7-preview", directory => {
      writeFileSync(join(directory, "secrets.env"), `TELEGRAM_TOKEN=${fake("1234567890:", EXAMPLE + EXAMPLE)}\n`);
      writeFileSync(join(directory, "notes.md"), "no credential here\n");
      writeFileSync(join(directory, "blob.bin"), Buffer.alloc(1024 * 1024, 7));
    });
    try {
      await prepared(f);
      const preview = await capture(f, { largeBytesThreshold: 1024 });
      const paths = preview.files.map(one => one.path).sort();
      assert.deepEqual(paths, ["blob.bin", "inside.txt", "notes.md", "secrets.env", "staged.txt", "tools/run.sh", "tracked.txt", "untracked.txt"], "every uncommitted file is listed by path");
      assert.equal(preview.files.some(one => one.path === "ignored.log"), false, "an ignored file is not published and not listed as published");
      assert.equal(preview.files.find(one => one.path === "staged.txt")!.status, "M ", "a staged change is shown as staged");
      assert.equal(preview.files.find(one => one.path === "tracked.txt")!.status, " M", "an unstaged change to a tracked file is shown as such");
      assert.equal(preview.files.find(one => one.path === "untracked.txt")!.status, "??");

      assert.deepEqual(preview.flagged.map(one => one.path), ["secrets.env"], "only the credential-shaped file is flagged");
      assert.deepEqual(preview.flagged[0]!.shapes.sort(), ["assigned_secret", "credential_filename", "telegram_bot_token"]);
      assert.deepEqual(preview.files.find(one => one.path === "notes.md")!.shapes, [], "an ordinary file is not flagged");

      assert.equal(preview.totalBytes > 1024 * 1024, true, "size is reported before publishing");
      assert.equal(preview.largestBytes, statSync(join(f.directory, "blob.bin")).size);
      assert.equal(preview.large, true, "a large package says so in the one preview");
      assert.match(preview.risk, /stays in that remote's history/i);
      assert.match(preview.risk, /deleting the file afterwards does not unpublish it/i);
      assert.match(preview.mitigation, /gitignore the file and re-capture/i);
      assert.deepEqual(preview.requiredConfirmations, ["credential_exposure", "publish"], "a flagged match takes its own confirmation, separate from Publish");

    } finally { f.dispose(); }

    const plain = fixture("tm-t0-7-plain");
    try {
      await prepared(plain);
      const clean = await capture(plain);
      assert.deepEqual(clean.flagged, [], "nothing in an ordinary tree is flagged");
      assert.deepEqual(clean.requiredConfirmations, ["publish"], "with nothing flagged, Publish is the only tap");
      assert.equal(clean.large, false);
    } finally { plain.dispose(); }
  });

  await t.test("Preview: the factual package is generated without an LLM call, and a summary may enrich it afterwards", async () => {
    const f = fixture("tm-t0-7-context");
    try {
      await prepared(f);
      const preview = await capture(f);
      assert.equal(preview.context.summary, null, "capture makes no model call");
      assert.equal(preview.context.objective, "Finish the capture");
      assert.equal(preview.context.recommendedProvider, PROVIDER);
      assert.equal(preview.context.recommendedModel, MODEL);
      assert.equal(preview.context.baseline.head, git(f.directory, ["rev-parse", "HEAD"]), "the export baseline is recorded for apply");
      assert.deepEqual(preview.context.baseline.staged, ["staged.txt"], "staged state is recorded separately from the working tree");
      assert.equal(preview.context.baseline.worktree.includes("tracked.txt"), true);
      assert.deepEqual(JSON.parse(git(f.directory, ["cat-file", "blob", `${preview.snapshotCommit}:${preview.contextPath}`])), preview.context);

      const enriched = await attachHandoverSummary(preview, async () => "A short read-only summary.");
      assert.equal(enriched.context.summary, "A short read-only summary.");
      const failed = await attachHandoverSummary(preview, async () => { throw new Error("quota exhausted"); });
      assert.equal(failed.context.summary, null, "a failed summary does not invalidate captured evidence");
      assert.equal(failed.snapshotCommit, preview.snapshotCommit);

      const source = readFileSync(new URL("./teamHandoverCapture.ts", import.meta.url), "utf8");
      assert.doesNotMatch(source, /anthropic|runAgent|startRun|adapters\//i, "capture generates the factual package without LLM calls");
      assert.doesNotMatch(source, /--force|force-with-lease|push\s+-f|update-ref\s+-d|--delete/, "no code path force-pushes or deletes a ref");
    } finally { f.dispose(); }
  });

  await t.test("Secret warning: the flagged confirmation is its own tap, and declining it publishes nothing", async () => {
    const f = fixture("tm-t0-7-secret", directory => {
      writeFileSync(join(directory, "deploy.sh"), `curl -H "Authorization: Bearer ${EXAMPLE}${EXAMPLE}"\n`);
    });
    try {
      await prepared(f);
      const preview = await capture(f);
      assert.deepEqual(preview.flagged.map(one => one.path), ["deploy.sh"]);
      assert.equal(preview.blocked, false, "the preview warns and does not refuse");

      await assert.rejects(
        () => publish(f, preview, { confirmations: ["publish"] }),
        (error: unknown) => error instanceof WorkspaceError
          && error.code === "credential_confirmation_required"
          && error.fields?.paths === "deploy.sh",
        "the ordinary Publish tap does not carry the flagged match",
      );
      assert.equal(branchExists(f.bare, f.itemId), false, "declining the flagged confirmation leaves no branch");
      assert.equal((await f.control.read())!.record.state, "PREPARING", "no record transition");
      assert.equal(workspaces.itemLink(f.itemId)!.controlHead, (await f.control.read())!.head, "and no offer");

      const published = await publish(f, preview, { confirmations: ["credential_exposure", "publish"] });
      assert.equal(published.outcome.record.state, "OFFERED", "a deliberate second tap proceeds; the warning never refuses");
    } finally { f.dispose(); }
  });

  await t.test("Secret warning: the credential shapes the detector names", () => {
    const cases: Array<[string, CredentialShapeId]> = [
      [fake("AKIA", "EXAMPLEEXAMPLE12"), "aws_access_key_id"],
      [fake("ghp_", EXAMPLE + "example"), "github_token"],
      [fake("github_pat_", EXAMPLE + EXAMPLE), "github_token"],
      [fake("sk-ant-", EXAMPLE), "provider_api_key"],
      [fake("glpat-", EXAMPLE), "provider_api_key"],
      [fake("1234567890:", EXAMPLE + EXAMPLE), "telegram_bot_token"],
      [`Authorization: Bearer ${EXAMPLE}`, "bearer_token"],
      [`api_key = "${EXAMPLE}"`, "assigned_secret"],
      [`password=${EXAMPLE}`, "assigned_secret"],
      [pem("RSA"), "private_key"],
      [pem("OPENSSH"), "private_key"],
    ];
    for (const [value, shape] of cases) {
      assert.equal(detectCredentialShapes(`before ${value} after`).includes(shape), true, `${shape} is detected`);
    }
    for (const benign of ["a plain sentence", "token of appreciation", "version = 1.2.3", "sk- is not a key", "AKIA is not a key"]) {
      assert.deepEqual(detectCredentialShapes(benign), [], benign);
    }
    assert.deepEqual([...new Set(CREDENTIAL_SHAPES.map(one => one.id))].length, CREDENTIAL_SHAPES.length, "every shape has its own id");
    for (const shape of CREDENTIAL_SHAPES) assert.equal(shape.label.trim() !== "", true, `${shape.id} is named for the preview`);
  });

  await t.test("Publish: the branch is pushed and verified retrievable before the record is OFFERED at epoch 1", async () => {
    const f = fixture("tm-t0-7-publish");
    try {
      await prepared(f);
      const preview = await capture(f);
      const calls: string[] = [];
      const wrapped = recorder(f.control, f.packages, calls);
      const published = await publishHandoverOffer({
        preview, control: wrapped.control, packages: wrapped.packages,
        commandId: "publish-ok", actor: { personId: REQUESTER },
        confirmations: ["publish"], acknowledgedBytes: preview.totalBytes,
      });

      assert.equal(calls.indexOf("package.publish") < calls.indexOf("package.verify"), true);
      assert.equal(calls.indexOf("package.verify") < calls.indexOf("control.append"), true, "objects are verified retrievable before OFFERED is published");
      assert.equal(calls.filter(one => one === "control.append").length, 1, "one update, no blind retry");

      assert.equal(git(f.bare, ["rev-parse", `refs/heads/${handoverBranch(f.itemId)}`]), preview.snapshotCommit);
      assert.equal(await f.packages.verify(preview.snapshotCommit, handoverBranch(f.itemId)), true, "every package object is retrievable from the remote");
      assert.equal(published.outcome.record.state, "OFFERED");
      assert.equal(published.outcome.record.epoch, 1, "the offer is published at epoch 1");
      assert.equal(published.outcome.record.executor, null, "the offer names no receiver");
      assert.equal(published.offer.receiver, null);
      assert.equal(published.offer.provider, PROVIDER);
      assert.equal(published.offer.model, MODEL);
      assert.equal(published.offer.branch, handoverBranch(f.itemId));
      assert.equal(published.offer.snapshotCommit, preview.snapshotCommit);
      const deadline = Date.parse(published.outcome.record.offerDeadline!) - Date.parse(published.outcome.record.updatedAt);
      assert.equal(deadline, 24 * 60 * 60 * 1000, "the offer carries the 24-hour start deadline");
      assert.equal(published.offer.startDeadline, published.outcome.record.offerDeadline);

      const read = await readPublishedOffer((await f.control.read())!.record, f.control);
      assert.deepEqual(read, published.offer, "a teammate reads the same offer back from the record");
      assert.equal(workspaces.itemLink(f.itemId)!.controlHead, (await f.control.read())!.head);
      assert.equal(workspaces.itemLink(f.itemId)!.epoch, 1);
      assert.equal(git(f.bare, ["ls-tree", "--name-only", `refs/heads/${handoverBranch(f.itemId)}`]).includes("ignored.log"), false);
      assert.equal(spawnSync("git", ["--git-dir", f.bare, "rev-parse", "--verify", "-q", controlRef(f.itemId)]).status, 0);
    } finally { f.dispose(); }
  });

  await t.test("Publish: size is confirmed against the preview the requester saw", async () => {
    const f = fixture("tm-t0-7-size");
    try {
      await prepared(f);
      const preview = await capture(f);
      await assert.rejects(
        () => publish(f, preview, { acknowledgedBytes: preview.totalBytes - 1 }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "size_unconfirmed",
        "no silent push of a size the requester never saw",
      );
      assert.equal(branchExists(f.bare, f.itemId), false);
      await assert.rejects(
        () => publish(f, preview, { confirmations: [] }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "publish_unconfirmed",
      );
      assert.equal(branchExists(f.bare, f.itemId), false);
      assert.equal(LARGE_PACKAGE_BYTES, 100 * 1024 * 1024, "the large-package notice is keyed to a multi-hundred-megabyte push");
    } finally { f.dispose(); }
  });

  await t.test("Publish: a failure between the branch and the record leaves an unreferenced branch but no executable offer", async () => {
    const f = fixture("tm-t0-7-between");
    try {
      await prepared(f);
      const preview = await capture(f);
      const stalled: ControlRecordRemote = {
        read: () => f.control.read(),
        readEvent: () => Promise.resolve(null),
        append: async () => "uncertain",
      };
      await assert.rejects(
        () => publishHandoverOffer({
          preview, control: stalled, packages: f.packages,
          commandId: "publish-stall", actor: { personId: REQUESTER },
          confirmations: ["publish"], acknowledgedBytes: preview.totalBytes,
        }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_push_uncertain",
      );
      assert.equal(branchExists(f.bare, f.itemId), true, "the branch is an unreferenced artifact");
      assert.equal((await f.control.read())!.record.state, "PREPARING", "but no executable incomplete offer exists");
      assert.equal(await readPublishedOffer((await f.control.read())!.record, f.control), null);
    } finally { f.dispose(); }
  });

  await t.test("Publish: an unreachable remote offers nothing and says what it is waiting for", async () => {
    const f = fixture("tm-t0-7-offline");
    try {
      await prepared(f);
      const preview = await capture(f);
      const grant = workspaces.grantItemCapability({ itemId: f.itemId, personId: RECEIVER, capability: "context", commandId: "grant-offline" });
      const unreachable: HandoverPackageRemote = {
        publish: () => { throw new WorkspaceError(503, "handover_unreachable", "Waiting for the project repository to become reachable."); },
        verify: () => Promise.resolve(false),
      };
      await assert.rejects(
        () => publishHandoverOffer({
          preview, control: f.control, packages: unreachable,
          commandId: "publish-offline", actor: { personId: REQUESTER },
          confirmations: ["publish"], acknowledgedBytes: preview.totalBytes,
        }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "handover_unreachable" && /waiting/i.test(error.message),
      );
      assert.equal(branchExists(f.bare, f.itemId), false, "nothing is offered");
      assert.equal((await f.control.read())!.record.state, "PREPARING");
      assert.equal(workspaces.itemGrants(f.itemId, { activeOnly: true }).length, 1, "grants and threads are untouched by an unreachable remote");
      assert.equal(workspaces.itemGrants(f.itemId)[0]!.grantedCommandId, grant.grantedCommandId);
    } finally { f.dispose(); }
  });

  await t.test("Publish: verification that fails leaves the record alone, and a lost race is re-read rather than retried", async () => {
    const f = fixture("tm-t0-7-race");
    try {
      await prepared(f);
      const preview = await capture(f);
      const unverifiable: HandoverPackageRemote = { publish: () => Promise.resolve("published"), verify: () => Promise.resolve(false) };
      await assert.rejects(
        () => publishHandoverOffer({
          preview, control: f.control, packages: unverifiable,
          commandId: "publish-unverified", actor: { personId: REQUESTER },
          confirmations: ["publish"], acknowledgedBytes: preview.totalBytes,
        }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "package_not_retrievable",
        "an unverifiable package never becomes an offer",
      );
      assert.equal((await f.control.read())!.record.state, "PREPARING");

      // Another workstation withdraws the preparation from the same head first.
      await applyControlTransition(f.control, {
        event: "abandon_preparation", actor: { personId: REQUESTER }, commandId: "abandon-race",
        epoch: (await f.control.read())!.record.epoch,
      });
      const calls: string[] = [];
      const wrapped = recorder(f.control, f.packages, calls);
      await assert.rejects(
        () => publishHandoverOffer({
          preview, control: wrapped.control, packages: wrapped.packages,
          commandId: "publish-lost", actor: { personId: REQUESTER },
          confirmations: ["publish"], acknowledgedBytes: preview.totalBytes,
        }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_state_invalid" && error.fields?.state === "LOCAL",
        "the loser reports the state that actually exists",
      );
      assert.equal(calls.filter(one => one === "control.append").length, 0, "and re-validates rather than retrying");
    } finally { f.dispose(); }
  });

  await t.test("Durable: a refused or declined case writes no action, no receipt, no offer and no control_head", async () => {
    const f = fixture("tm-t0-7-durable", directory => writeFileSync(join(directory, "id_rsa"), `${pem("OPENSSH")}\nbody\n`));
    try {
      const db = database();
      const count = () => ({
        actions: (db.prepare("SELECT COUNT(*) n FROM task_control_action WHERE item_id=?").get(f.itemId) as { n: number }).n,
        receipts: (db.prepare("SELECT COUNT(*) n FROM task_control_receipt").get() as { n: number }).n,
      });
      try {
        const started = await prepared(f);
        const before = count();
        const head = workspaces.itemLink(f.itemId)!.controlHead;
        assert.equal(head, started.head);
        const preview = await capture(f);
        await assert.rejects(() => publish(f, preview), (error: unknown) => error instanceof WorkspaceError && error.code === "credential_confirmation_required");
        assert.deepEqual(count(), before, "a declined publish writes no action and no receipt");
        assert.equal(workspaces.itemLink(f.itemId)!.controlHead, head, "and no control_head beyond the preparation it already had");
        assert.equal(branchExists(f.bare, f.itemId), false);
        assert.equal(await readPublishedOffer((await f.control.read())!.record, f.control), null);
      } finally { db.close(); }
    } finally { f.dispose(); }
  });

  await t.test("Trigger: grants end when handover starts, and a refused start leaves them alone", async () => {
    const f = fixture("tm-t0-7-grants");
    try {
      workspaces.grantItemCapability({ itemId: f.itemId, personId: RECEIVER, capability: "answer", commandId: "grant-a" });
      workspaces.grantItemCapability({ itemId: f.itemId, personId: RECEIVER, capability: "resume", commandId: "grant-b" });
      assert.equal(workspaces.itemGrants(f.itemId, { activeOnly: true }).length, 2);
      await prepared(f);
      assert.equal(workspaces.itemGrants(f.itemId, { activeOnly: true }).length, 0, "existing grants end when handover starts");
      assert.equal(workspaces.itemGrants(f.itemId).length, 2, "the grant history is kept, not deleted");
    } finally { f.dispose(); }
  });

  await t.test("Gate: handover routes only behind its own capability, and both Team settings are off by default", () => {
    // H04 opened this gate, because H04 is what produces RTC-12's evidence.
    // Until it did, every handover tap was refused outright with
    // `action_not_available`. What replaced that refusal is a narrower one:
    // handover taps are still the first thing checked, and they are refused
    // unless Team *and* handover are both enabled.
    const source = readFileSync(new URL("./taskControl.ts", import.meta.url), "utf8");
    assert.match(source, /HANDOVER_ACTIONS as readonly string\[\]\)\.includes\(action\.action\)/,
      "handover taps are still recognised before anything else can read them as an ordinary resume");
    assert.match(source, /this\.config\.teamEnabled !== true\) return this\.reject\(input, "team_disabled"/,
      "and refused while Team is disabled");
    assert.match(source, /this\.config\.handoverEnabled !== true[\s\S]{0,120}"handover_disabled"/,
      "and refused while handover's own capability is disabled");
    assert.match(source, /handoverEnabled: settings\.team\.handoverEnabled/,
      "with the capability read from the setting rather than assumed");
    assert.equal(settings.team.enabled, false, "team.enabled is still off by default");
    assert.equal(settings.team.handoverEnabled, false, "and handover has its own setting, also off by default");
  });
});

