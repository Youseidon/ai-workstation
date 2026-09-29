import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const verifier = new URL("./verify-live-two-workstation-roundtrip.mjs", import.meta.url);
const itemId = "awi1_0123456789abcdef01234567";
const branch = `aw/handover/${itemId}`;
const offeredCommit = "1".repeat(40);
const returnedCommit = "2".repeat(40);
const controlOffered = "3".repeat(40);
const controlReturned = "4".repeat(40);
const controlCompleted = "5".repeat(40);
const expectedGroup = "-1000000000000";
const expectedBots = ["@requester_test_bot", "@receiver_test_bot"];
const expectedRemote = "https://example.invalid/team/repository.git";

function delivery(kind, actionRef, outboxId, messageId) {
  return {
    outboxId,
    botId: "bot-id",
    chatId: expectedGroup,
    topicId: null,
    messageId,
    createdAt: "2026-09-29T00:01:00.000Z",
    deliveredAt: "2026-09-29T00:01:01.000Z",
    cardKind: kind,
    itemId,
    actionRef,
    matchingSentCards: 1,
  };
}

function action(name, actionRef, route) {
  return {
    actionRef,
    action: name,
    receiptState: "APPLIED",
    commandId: `web-${name}-command`,
    receiptCreatedAt: "2026-09-29T00:02:00.000Z",
    invocation: "web_route",
    route,
  };
}

function fixture() {
  const offer = delivery("handover_offer", "tc_offer", 11, "101");
  const returnPrompt = delivery("team_item_action", "tc_return", 12, "102");
  return {
    startedAt: "2026-09-29T00:00:00.000Z",
    finishedAt: "2026-09-29T00:10:00.000Z",
    dryRun: false,
    title: "WI_REAL_HANDOVER_TEST",
    fileName: "handover-real-test.txt",
    exactLine: "Team handover real round trip test",
    promptId: 4,
    itemId,
    telegram: {
      configured: { groupId: expectedGroup, bots: expectedBots },
      databaseSources: { requester: "/pilot-a/console.sqlite", receiver: "/pilot-b/console.sqlite" },
      deliveries: {
        offer,
        returnPrompt,
        returned: delivery("handover_review", "tc_apply", 13, "103"),
      },
      actions: {
        accept: action("accept_offer", offer.actionRef, `/api/task-control/team/handovers/${itemId}/accept`),
        return: action("return_work", returnPrompt.actionRef, `/api/task-control/team/handovers/${itemId}/return`),
      },
    },
    github: {
      remote: expectedRemote,
      offered: {
        handoverRef: `${offeredCommit}\trefs/heads/${branch}`,
        controlRef: `${controlOffered}\trefs/aw/items/${itemId}/control`,
      },
      returned: {
        handoverRef: `${returnedCommit}\trefs/heads/${branch}`,
        controlRef: `${controlReturned}\trefs/aw/items/${itemId}/control`,
      },
      completed: {
        handoverRef: "",
        controlRef: `${controlCompleted}\trefs/aw/items/${itemId}/control`,
      },
    },
    requester: {
      offered: { state: "OFFERED", branch },
      returned: { state: "RETURNED" },
      completed: { state: "COMPLETED", resultLabel: "full" },
      reviewText: "Returned as full and merges cleanly.",
      head: returnedCommit,
      fileContent: "Team handover real round trip test",
    },
    receiver: {
      accepted: { state: "RUNNING" },
      finished: { localTask: { runState: "DONE", runId: "run_test" } },
    },
  };
}

function verify(value) {
  const directory = mkdtempSync(join(tmpdir(), "roundtrip-verifier-"));
  const evidencePath = join(directory, "evidence.json");
  try {
    writeFileSync(evidencePath, JSON.stringify(value));
    return spawnSync(process.execPath, [verifier.pathname, evidencePath], {
      encoding: "utf8",
      env: {
        ...process.env,
        TEAM_HANDOVER_EXPECTED_REMOTE: expectedRemote,
        TEAM_HANDOVER_TELEGRAM_GROUP_ID: expectedGroup,
        TEAM_HANDOVER_TELEGRAM_BOTS: expectedBots.join(","),
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("accepts delivery/action, staged Git refs, reverse return and apply evidence", () => {
  const result = verify(fixture());
  assert.equal(result.status, 0, result.stderr);
});

test("configured Telegram constants alone are not delivery proof", () => {
  const evidence = fixture();
  evidence.telegram.deliveries = {};
  const result = verify(evidence);
  assert.equal(result.status, 1, "configured destinations must not substitute for delivery records");
});

test("accepts a processed Telegram callback as action invocation proof", () => {
  const evidence = fixture();
  evidence.telegram.actions.accept = {
    ...evidence.telegram.actions.accept,
    invocation: "telegram_callback",
    route: null,
    commandId: "callback-command",
    callback: {
      updateId: 901,
      callbackQueryId: "callback-901",
      callbackData: "tc_offer",
      processedAt: "2026-09-29T00:02:00.000Z",
    },
  };
  const result = verify(evidence);
  assert.equal(result.status, 0, result.stderr);
});

test("requires the handover ref before apply and its cleanup afterward", () => {
  const evidence = fixture();
  evidence.github.returned.handoverRef = "";
  evidence.github.completed.handoverRef = `${returnedCommit}\trefs/heads/${branch}`;
  const result = verify(evidence);
  assert.equal(result.status, 1, "the result ref must be observed before apply and deleted afterward");
});
