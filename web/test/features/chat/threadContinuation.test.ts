import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const consoleSource = readFileSync(new URL("../../../contexts/hydra.tsx", import.meta.url), "utf8");
const chatSource = readFileSync(new URL("../../../features/chat/components/ChatWorkspace.tsx", import.meta.url), "utf8");
// Chat state is owned by the shell-level controller, not the `/` route.
const pageSource = readFileSync(new URL("../../../features/chat/hooks/useChatController.tsx", import.meta.url), "utf8");
const activitySource = readFileSync(new URL("../../../features/activity/components/ActivityView.tsx", import.meta.url), "utf8");

test("custom chat follow-ups resume the same provider session in their tab", () => {
  assert.match(consoleSource, /current\.source\.type === "custom"/);
  assert.match(consoleSource, /\[current\.provider\]: \{ sessionId: announcedSession, workspaceId: current\.workspace\.id, startedAt:current\.startedAt \}/);
  assert.match(consoleSource, /state\.tabSessions\[tabId\]\?\.\[provider\]\?\.workspaceId === workspaceId/);
  assert.match(consoleSource, /resumeSessionId: state\.tabSessions\[tabId\]!\[provider\]!\.sessionId/);
});

test("custom chat turns keep a provider-neutral persisted thread", () => {
  assert.match(consoleSource, /"prompt" in source \? \{ threadId: tabId \}/);
  assert.match(pageSource, /crypto\.randomUUID\(\)/);
});

test("activity groups every run in a persisted thread", () => {
  assert.match(activitySource, /const grouped = new Map<string, ActivityRow>/);
  assert.match(activitySource, /grouped\.get\(row\.threadId\)/);
  assert.match(activitySource, /turnCount: previous\.turnCount \+ row\.turnCount/);
  assert.match(activitySource, /selected\.runIds\.includes\(session\.id\)/);
});

test("saved work items and consults do not inherit chat sessions", () => {
  assert.match(consoleSource, /"prompt" in source/);
  assert.match(consoleSource, /startConsult:[\s\S]*role: "consult"/);
  assert.doesNotMatch(consoleSource.match(/startConsult:[\s\S]*?askClarification:/)?.[0] ?? "", /resumeSessionId/);
});

test("a follow-up keeps the opening turn's tab title", () => {
  assert.match(chatSource, /if \(writerItems\.length === 0\) onTitle/);
});

test("activity can reopen a durable thread and Chat persists its tabs", () => {
  assert.match(activitySource, /Continue in Chat/);
  assert.match(activitySource, /thread=\$\{encodeURIComponent\(selected\.threadId\)\}/);
  assert.match(pageSource, /hydra\.chat-tabs\.v1/);
  assert.match(pageSource, /latestConsole\.current\.restoreThread\(tab\.id,page\.sessions\)/);
  assert.match(consoleSource, /case "restore_thread"/);
  assert.match(consoleSource, /session\.providerSessionId/);
});
