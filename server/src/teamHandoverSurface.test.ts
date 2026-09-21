import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, SuiteRecord, PromptRecord } from "@agent-console/shared";
import { updateSettings, settings } from "./settings.ts";
import { TaskControlService, type HandoverTap } from "./taskControl.ts";
import { mintItemId } from "./teamItems.ts";
import type { TeamRoster } from "./teamRoster.ts";
import { compareCapabilities } from "./teamHandoverRun.ts";
import {
  HANDOVER_SANDBOX,
  beginItemHandover,
  handleHandoverTap,
  listControlItems,
  pollControlRecords,
  previewItemHandover,
  publishItemHandover,
  receiverPolicy,
  requesterEnvironment,
  type SurfaceContext,
} from "./teamHandoverSurface.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

/*
 * The handover surface (H06, gap register C1).
 *
 * The engine was complete and had no caller. These cases assert the three joins
 * this task adds, at the tier where they can be asserted without two app roots:
 * the requester's begin/preview/publish path against a real shared repository,
 * the control-record read that makes a receiver discover an open call without
 * being told an item id, and the tap handler `registerHandoverTapHandler` never
 * had. The two-database half is TM-T1-H1 to TM-T1-H3.
 *
 * Every case restores both settings, because both are false by default and the
 * default-off contract is what the last case here asserts.
 */

const REQUESTER = "jd";
const RECEIVER = "yousef";
const PROVIDER = "claude";

function git(directory: string, args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

interface Fixture {
  itemId: string;
  promptId: number;
  bare: string;
  /** The requester's own checkout: the workspace the item's task lives in. */
  source: string;
  /** The receiver's own clone of the shared remote. */
  clone: string;
  roster: TeamRoster;
  requester: SurfaceContext;
  receiver: SurfaceContext;
  dispose(): void;
}

function fixture(prefix: string): Fixture {
  const itemId = mintItemId();
  const groupChat = `-100${itemId.slice(-10)}`;
  const bare = mkdtempSync(join(tmpdir(), `${prefix}-bare-`));
  const source = mkdtempSync(join(tmpdir(), `${prefix}-src-`));
  const clone = mkdtempSync(join(tmpdir(), `${prefix}-clone-`));
  execFileSync("git", ["init", "--bare", "-q", bare]);

  git(source, ["init", "-q", "-b", "work"]);
  git(source, ["config", "user.email", "jd@invalid"]);
  git(source, ["config", "user.name", "jd"]);
  writeFileSync(join(source, "task.md"), "half finished\n");
  git(source, ["add", "-A"]);
  git(source, ["commit", "-q", "-m", "base"]);
  // The uncommitted work the package carries, so the preview has something to list.
  writeFileSync(join(source, "task.md"), "half finished, then some\n");
  writeFileSync(join(source, "notes.md"), "what is left\n");
  execFileSync("git", ["clone", "-q", bare, clone]);

  const workspace = workspaces.create({ name: `${prefix}-source`, workDirectory: source });
  const receiverWorkspace = workspaces.create({ name: `${prefix}-clone`, workDirectory: clone });
  const program = workspaces.createChild("program", workspace.id, { name: "Team", overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Items", overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: `Item ${prefix}`, content: "Finish the colour work." }) as PromptRecord;
  workspaces.createItemLink({ itemId, promptId: prompt.id, role: "requester", epoch: 1 });

  const roster: TeamRoster = {
    version: 1,
    teamId: `awt1_${prefix}`,
    groupChatId: groupChat,
    remoteUrl: bare,
    members: [
      { personId: REQUESTER, telegramUserId: "9000", botId: "jd-bot", botUsername: "jd_bot", workstationId: "jd-laptop", workstationLabel: "jd-laptop", personLabel: "jd" },
      { personId: RECEIVER, telegramUserId: "9001", botId: "yousef-bot", botUsername: "yousef_bot", workstationId: "yousef-desktop", workstationLabel: "yousef-desktop", personLabel: "Yousef" },
    ],
    usedInviteIds: [],
    commandIds: [],
    updatedAt: new Date().toISOString(),
  };
  for (const member of roster.members) {
    workspaces.upsertTeamGroupActor({
      id: `fake-tg-${member.personId}-group-${itemId}`,
      transport: "telegram",
      transportUserId: member.telegramUserId,
      chatId: groupChat,
      label: member.personLabel,
    });
  }

  return {
    itemId,
    promptId: prompt.id,
    bare,
    source,
    clone,
    roster,
    requester: { roster, botId: "jd-bot", providers: [PROVIDER] },
    receiver: { roster, botId: "yousef-bot", providers: [PROVIDER] },
    dispose() {
      for (const entry of workspaces.list()) {
        if (entry.id === workspace.id || entry.id === receiverWorkspace.id) workspaces.remove(entry.id);
      }
      for (const directory of [bare, source, clone]) rmSync(directory, { recursive: true, force: true });
    },
  };
}

function enable(): void {
  updateSettings({ "team.enabled": true, "team.handoverEnabled": true });
}

function disable(): void {
  updateSettings({ "team.enabled": false, "team.handoverEnabled": false });
}

/** Env A's whole requester path through the surface, as the routes drive it. */
async function offered(f: Fixture) {
  await beginItemHandover(f.requester, f.itemId);
  const preview = await previewItemHandover(f.requester, f.itemId, { provider: PROVIDER });
  const published = await publishItemHandover(f.requester, f.itemId, {
    confirmations: ["publish"],
    acknowledgedBytes: preview.totalBytes,
  });
  return { preview, ...published };
}

test("C1: the requester's route path captures, publishes and leaves an open call on the shared remote", async () => {
  enable();
  const f = fixture("surface-publish");
  try {
    const { preview, offer, record } = await offered(f);

    // The preview is what TM-T0-7 requires a requester to see before anything
    // is pushed: every uncommitted file by path, and the package's own size.
    assert.deepEqual(preview.files.map(one => one.path).sort(), ["notes.md", "task.md"]);
    assert.ok(preview.totalBytes > 0);
    assert.deepEqual(preview.requiredConfirmations, ["publish"]);

    // The offer is an open call: it names no receiver, whatever accepted it.
    assert.equal(offer.receiver, null);
    assert.equal(record.state, "OFFERED");
    assert.equal(record.executor, null);
    assert.equal(offer.sandbox, HANDOVER_SANDBOX, "an offer states the sandbox it is to be run under");

    // The branch and the record are both on the shared remote, and the record
    // is in its own namespace outside refs/heads.
    assert.equal(git(f.bare, ["rev-parse", `refs/heads/${offer.branch}`]), offer.snapshotCommit);
    assert.deepEqual(listControlItems(f.bare), [f.itemId]);

    // HEAD, the index and the worktree are untouched by the capture.
    assert.equal(git(f.source, ["rev-parse", "--abbrev-ref", "HEAD"]), "work");
    assert.equal(git(f.source, ["status", "--porcelain=v1"]).split("\n").length, 2);
  } finally {
    f.dispose();
    disable();
  }
});

test("C1: nothing is published from a package nobody previewed", async () => {
  enable();
  const f = fixture("surface-unpreviewed");
  try {
    await beginItemHandover(f.requester, f.itemId);
    await assert.rejects(
      () => publishItemHandover(f.requester, f.itemId, { confirmations: ["publish"], acknowledgedBytes: 0 }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "preview_required",
    );
    assert.deepEqual(git(f.bare, ["for-each-ref", "--format=%(refname)", "refs/heads/aw"]), "");
  } finally {
    f.dispose();
    disable();
  }
});

test("C1: the control-record read is what makes a receiver discover an open call", async () => {
  enable();
  const f = fixture("surface-discover");
  try {
    const { offer } = await offered(f);

    // Nothing told env B this item exists. The read is the discovery.
    const discovered = await pollControlRecords(f.receiver);
    assert.deepEqual(discovered.discovered, [f.itemId]);
    assert.equal(discovered.items, 1);

    // The card is posted by the receiver's own bot, not the requester's.
    const outbox = workspaces.handoverOfferCardOutbox("yousef-bot", f.itemId);
    assert.notEqual(outbox, null, "the receiver's own bot posts its own Accept card");
    assert.equal(workspaces.handoverOfferCardOutbox("jd-bot", f.itemId), null);
    const actions = workspaces.handoverActionsForItem("yousef-bot", f.itemId);
    assert.deepEqual(actions.map(one => one.action).sort(), ["accept_offer", "decline_offer"]);

    // A second read does not repost it.
    await pollControlRecords(f.receiver);
    assert.equal(workspaces.handoverOfferCardOutbox("yousef-bot", f.itemId), outbox);

    // The requester does not accept their own open call.
    const own = await pollControlRecords(f.requester);
    assert.deepEqual(own.discovered, []);
    assert.equal(workspaces.handoverOfferCardOutbox("jd-bot", f.itemId), null);

    // The requested capabilities are inside the receiver's own policy, so the
    // Accept card is offered rather than withheld (RTC-12, within_limit).
    const comparison = compareCapabilities(
      { provider: offer.provider, model: offer.model, hostAccess: false, sandbox: HANDOVER_SANDBOX, tools: [] },
      receiverPolicy([PROVIDER]),
    );
    assert.equal(comparison.outcome, "within_limit");
    assert.equal(comparison.runnable, true);
  } finally {
    f.dispose();
    disable();
  }
});

test("RTC-12: a provider this workstation is not logged in to is unknown, not permission", () => {
  const comparison = compareCapabilities(
    { provider: "codex", model: null, hostAccess: false, sandbox: HANDOVER_SANDBOX, tools: [] },
    receiverPolicy(["claude"]),
  );
  assert.equal(comparison.outcome, "unknown");
  assert.equal(comparison.runnable, false, "an omitted requirement is not permission");
  assert.deepEqual(comparison.unknown, ["provider:codex"]);
});

test("C1: a tap routes into the engine, and the claim is the record's compare-and-swap", async () => {
  enable();
  const f = fixture("surface-tap");
  try {
    await offered(f);
    await pollControlRecords(f.receiver);
    const accept = workspaces.handoverActionsForItem("yousef-bot", f.itemId).find(one => one.action === "accept_offer")!;

    const tap: HandoverTap = {
      action: "accept_offer",
      actionRef: accept.ref,
      itemId: f.itemId,
      epoch: 1,
      commandId: "b-accept-1",
      botId: "yousef-bot",
      chatId: f.roster.groupChatId,
      topicId: null,
      transportUserId: "9001",
      promptId: workspaces.handoverCandidatePrompt("yousef-bot", f.itemId)!,
    };
    const receipt = await handleHandoverTap(f.receiver, tap);
    assert.equal(receipt.state, "APPLIED");

    // The shared record, not the tap, is what records the claim.
    const state = JSON.parse(execFileSync("git", ["--git-dir", f.bare, "show", `refs/aw/items/${f.itemId}/control:state.json`], { encoding: "utf8" })) as { state: string; executor: string };
    assert.equal(state.state, "CLAIMED");
    assert.equal(state.executor, RECEIVER);

    // Duplicate delivery returns the first receipt and claims nothing twice.
    const replay = await handleHandoverTap(f.receiver, { ...tap, commandId: "b-accept-2" });
    assert.equal(replay.commandId, receipt.commandId, "a duplicate tap is answered from the first receipt");
  } finally {
    f.dispose();
    disable();
  }
});

test("C1: a tap this surface offers no button for is refused rather than read as something else", async () => {
  enable();
  const f = fixture("surface-unknown-tap");
  try {
    await offered(f);
    await pollControlRecords(f.receiver);
    const decline = workspaces.handoverActionsForItem("yousef-bot", f.itemId).find(one => one.action === "decline_offer")!;
    const receipt = await handleHandoverTap(f.receiver, {
      action: "withdraw_offer",
      actionRef: decline.ref,
      itemId: f.itemId,
      epoch: 1,
      commandId: "b-withdraw-1",
      botId: "yousef-bot",
      chatId: f.roster.groupChatId,
      topicId: null,
      transportUserId: "9001",
      promptId: workspaces.handoverCandidatePrompt("yousef-bot", f.itemId)!,
    });
    assert.equal(receipt.state, "REJECTED");
    assert.equal(receipt.errorCode, "action_not_available");
  } finally {
    f.dispose();
    disable();
  }
});

test("C1: both settings stay false by default, and each route says which one refused it", async () => {
  disable();
  assert.equal(settings.team.enabled, false, "team.enabled is false by default");
  assert.equal(settings.team.handoverEnabled, false, "team.handoverEnabled is false by default");

  const f = fixture("surface-default-off");
  try {
    // Team off.
    await assert.rejects(
      () => beginItemHandover(f.requester, f.itemId),
      (error: unknown) => error instanceof WorkspaceError && error.status === 403 && error.code === "team_disabled",
    );

    // Team on, handover off: a different capability, and it says so.
    updateSettings({ "team.enabled": true });
    for (const call of [
      () => beginItemHandover(f.requester, f.itemId),
      () => previewItemHandover(f.requester, f.itemId, { provider: PROVIDER }),
      () => publishItemHandover(f.requester, f.itemId, { confirmations: ["publish"], acknowledgedBytes: 0 }),
    ]) {
      await assert.rejects(call, (error: unknown) =>
        error instanceof WorkspaceError && error.status === 403 && error.code === "handover_disabled");
    }

    // The record is untouched by any of it, and the poll does nothing at all.
    assert.deepEqual(listControlItems(f.bare), []);
    assert.deepEqual(await pollControlRecords(f.receiver), { items: 0, discovered: [], reviewed: [], expired: [], returnable: [] });

    // The capability gate H04 built still refuses a tap, with both settings named.
    const control = new TaskControlService({
      enabled: true, teamEnabled: true, handoverEnabled: false,
      notificationsEnabled: true, remoteActionsEnabled: true, transport: "telegram", botId: "jd-bot",
    });
    let called = false;
    control.registerHandoverTapHandler(async () => { called = true; throw new Error("unreachable"); });
    assert.equal(called, false, "a registered handler is never reached while handover is off");
  } finally {
    f.dispose();
    disable();
  }
});

test("C1: the requester's environment is built from the roster, never from the offer", () => {
  enable();
  const f = fixture("surface-environment");
  try {
    const env = requesterEnvironment(f.requester, f.itemId);
    assert.equal(env.personId, REQUESTER);
    assert.equal(env.workstationId, "jd-laptop");
    assert.equal(env.botId, "jd-bot");
    assert.equal(env.remoteUrl, f.bare);
    assert.equal(env.workDirectory, f.source);
    assert.deepEqual(env.roster, [REQUESTER, RECEIVER]);
  } finally {
    f.dispose();
    disable();
  }
});
