import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_STATUS_CATALOG, type OperationsPrompt, type OperationsSuite } from "@agent-console/shared";
import { ToastProvider } from "@/components/ui/Toast";
import { HandoverControlView } from "./HandoverControl";
import { WorkItemDetail } from "./WorkItemDetail";
import { WorkItemList } from "./WorkItemList";

/*
 * M-16, the web half. The three surfaces the owner looks at while a teammate is
 * holding a work item, each rendered from props alone as F03 and F06 require.
 *
 * Before this, with the shared control record RUNNING and the executor another
 * person, the owner's page said:
 *
 *   row badge:      Needs you
 *   row buttons:    ["Respond"]
 *   detail buttons: "Respond and resume", "Retry with existing context", "Mark complete"
 *
 * It claimed the item needed the owner, which it did not, and it offered three
 * buttons that P-A5 now refuses with a 409 - dead buttons of exactly the shape
 * M-13 was. The surfaces could not have known better: nothing in the snapshot
 * carried the handover, which is what `heldByTeammate` is for.
 *
 * Both halves of each claim are asserted. A surface that hid the button
 * unconditionally would pass the held case and fail the unheld one.
 */

const HELD: NonNullable<OperationsPrompt["heldByTeammate"]> = {
  itemId: "awi1_75c3aabf7831461bc7c4a395",
  state: "RUNNING",
  executor: "6525517234",
};

function prompt(held: OperationsPrompt["heldByTeammate"]): OperationsPrompt {
  return {
    prompt: {
      id: 42, externalKey: "P42", title: "Finish the release colour work", status: "BLOCKED",
      currentRun: null, recoverable: false, recovery: { kind: "none", message: null }, children: [],
    },
    workspace: { id: 1, name: "ws", workDirectory: "/tmp/ws", workDirectoryExists: true },
    operationalState: "BLOCKED",
    attention: held === null,
    heldByTeammate: held,
    latestIntervention: null,
    humanIntervention: null,
    lastActivityAt: "2026-09-28T09:00:00.000Z",
    sessionCount: 1,
    latestHandoff: null,
    latestAudit: null,
    continuation: null,
    children: [],
    childAttention: null,
    childAttentionCount: 0,
  } as unknown as OperationsPrompt;
}

function suite(held: OperationsPrompt["heldByTeammate"]): OperationsSuite {
  return {
    id: 7, key: "S7", name: "Web review", programId: 3, programKey: "G3", programName: "prog",
    workspaceId: 1, workspaceName: "ws",
    counts: { WORKING: 0 },
    attentionCount: held === null ? 1 : 0,
    prompts: [prompt(held)],
    sessions: [],
    latestVerification: null,
    pipeline: null,
  } as unknown as OperationsSuite;
}

function list(held: OperationsPrompt["heldByTeammate"]): string {
  return renderToStaticMarkup(
    <WorkItemList
      suite={suite(held)}
      filter="all"
      activePromptId={null}
      busy={false}
      providerLabel="claude"
      canAct={() => true}
      onFilterChange={() => {}}
      onSelect={() => {}}
      onRun={() => {}}
      onStop={() => {}}
      onRecover={() => {}}
      onRespond={() => {}}
    />,
  );
}

/* WorkItemDetail's tree reaches DefinitionOfDonePanel, which calls `useToast`,
   so the provider is part of rendering it at all rather than part of this claim. */
function detail(held: OperationsPrompt["heldByTeammate"]): string {
  return renderToStaticMarkup(
    <ToastProvider><WorkItemDetail
      suite={null}
      item={prompt(held)}
      activity={null}
      statusCatalog={DEFAULT_STATUS_CATALOG}
      triggerSentences={{}}
      response="an answer the owner typed"
      busy={false}
      canStart
      verifyingItem={false}
      connectionOpen
      providerLabel="claude"
      model={null}
      onRun={() => {}}
      onStop={() => {}}
      onRecover={() => {}}
      onClassifyStartUnknown={() => {}}
      onAudit={() => {}}
      onRespond={() => {}}
      onRetryWithExistingContext={() => {}}
      onOpenHumanInput={() => {}}
      onResponseChange={() => {}}
      onComplete={() => {}}
      onVerifyItem={() => {}}
      onSelectChild={() => {}}
      onClose={() => {}}
    /></ToastProvider>,
  );
}

/**
 * Whether the button carrying this label is disabled.
 *
 * Read off the `disabled=""` attribute rather than by searching the tag for
 * "disabled": every Button carries the Tailwind variants
 * `disabled:pointer-events-none disabled:opacity-40` in its class list, so a
 * substring match on the word passes for an enabled button and asserts nothing.
 */
function isDisabled(markup: string, label: string): boolean {
  return / disabled=""/.test(buttonWith(markup, label));
}

/** The opening tag of the button that carries this label. */
function buttonWith(markup: string, label: string): string {
  const index = markup.indexOf(`>${label}<`);
  assert.notEqual(index, -1, `a button labelled "${label}" is rendered`);
  const open = markup.lastIndexOf("<button", index);
  assert.notEqual(open, -1, `"${label}" is inside a button`);
  return markup.slice(open, markup.indexOf(">", open) + 1);
}

function hasButton(markup: string, label: string): boolean {
  return markup.includes(`>${label}<`);
}

test("M-16: the row says who holds the item instead of claiming it needs the owner", () => {
  const held = list(HELD);
  /*
   * CHANGED for jd's answer of 2026-09-28 to m16-design.md section 4: resolve the
   * label. This asserted the person id the control record stores, because that was
   * all the badge had. The route now resolves the roster's own name, so the badge
   * names the person. The claim is unchanged - the row names the holder - and only
   * the spelling of the holder moves.
   */
  assert.match(held, /Held by Junaid/, "the badge names the holder");
  assert.equal(
    held.includes(">Needs you</span>"), false,
    "and does not also claim the item needs the owner",
  );

  // The same list with nothing held, so the assertion above is about the field
  // rather than about a badge that was removed.
  const free = list(null);
  assert.equal(free.includes(">Needs you</span>"), true, "an item nobody holds still says Needs you");
  assert.equal(free.includes("Held by"), false);
});

test("M-16: the row offers no Respond on an item a teammate is holding", () => {
  assert.equal(hasButton(list(HELD), "Respond"), false,
    "Respond is refused by the route with a 409, so the row must not offer it");
  assert.equal(hasButton(list(null), "Respond"), true,
    "and an item nobody holds still offers it - this is not a button that was deleted");
});

test("M-16: the detail's three actions are disabled while a teammate holds the item, and say why", () => {
  const held = detail(HELD);
  for (const label of ["Respond and resume", "Retry with existing context", "Mark complete"]) {
    assert.equal(isDisabled(held, label), true, `${label} is disabled while the item is held`);
  }
  // P-A5's own sentences, so the button's reason and the route's refusal agree.
  assert.match(held, /awi1_75c3aabf7831461bc7c4a395 is RUNNING/, "the reason names the item and its control state");
  // Same change, same reason: the reason a button is refused names them the same
  // way the badge does, which is why both read from one helper.
  assert.match(held, /Junaid is holding it, and only they can release it/, "and who has to release it");

  const free = detail(null);
  assert.equal(isDisabled(free, "Respond and resume"), false,
    "an item nobody holds still offers Respond and resume");
  assert.equal(isDisabled(free, "Retry with existing context"), false);
  assert.equal(free.includes("is holding it"), false, "and says nothing about a holder");
});

test("M-16: Prepare handover is disabled while a handover is already live, with the reason", () => {
  const base = {
    availability: { enabled: true } as const,
    preview: null,
    offer: null,
    preparing: false,
    publishing: false,
    credentialConfirmed: false,
    onCredentialConfirmed: () => {},
    provider: "claude" as const,
    onProvider: () => {},
    error: null,
    onPrepare: () => {},
    onPublish: () => {},
  };
  const held = renderToStaticMarkup(<HandoverControlView {...base} held={HELD} />);
  assert.equal(isDisabled(held, "Prepare handover"), true,
    "a second handover is refused server-side, so it is not offered here");
  assert.match(held, /awi1_75c3aabf7831461bc7c4a395 is RUNNING/, "and the control says why");

  const free = renderToStaticMarkup(<HandoverControlView {...base} held={null} />);
  assert.equal(isDisabled(free, "Prepare handover"), false,
    "with no live handover the control is offered as it always was");
});

test("M-16: an open offer nobody has accepted names no holder, and says to withdraw it", () => {
  const offered = { itemId: HELD.itemId, state: "OFFERED", executor: null };
  assert.match(list(offered), /Offered to the team/,
    "there is nobody to name, so the badge says what is true instead of `Held by null`");
  assert.match(detail(offered), /No one has accepted it yet, so withdraw the offer first/);
});
