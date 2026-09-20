import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamJoinCodeControl } from "./TeamStatusPanel";

const CODE = "awj1.eyJ2ZXJzaW9uIjoxLCJ0ZWFtSWQiOiJhd3QxX2V4YW1wbGUiLCJncm91cENoYXRJZCI6Ii0xMDAxIn0";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

test("B1: the Team status panel offers a new join code and shows what issuing one does not break", () => {
  const html = renderToStaticMarkup(<TeamJoinCodeControl joinCode={null} issuing={false} error={null} onIssue={() => {}} />);
  assert.match(html, /Issue new join code/);
  assert.doesNotMatch(html, /<button[^>]*\sdisabled=""/, "the action is live for an existing roster");
  assert.match(html, /single use and carries no credential/, "the code is credential-free, which T09 established");
  assert.match(html, /leaves any earlier code working until it is used or expires/, "reissuing does not invalidate the previous code");
  assert.doesNotMatch(html, /data-testid="team-join-code"/, "no code is shown until one is issued");
  assert.doesNotMatch(html, /role="alert"/);
});

test("B1: an issued code is shown in full, and a refused issue shows the server's reason instead", () => {
  const issued = renderToStaticMarkup(<TeamJoinCodeControl joinCode={CODE} issuing={false} error={null} onIssue={() => {}} />);
  assert.match(issued, new RegExp(`data-testid="team-join-code"[^>]*>${CODE}</code>`), "the whole code is rendered, not a truncation");
  assert.match(issued, /private channel/);
  assert.doesNotMatch(issued, /role="alert"/);

  const refused = renderToStaticMarkup(
    <TeamJoinCodeControl joinCode={null} issuing={false} error="Team roster changed; review it before trying again." onIssue={() => {}} />,
  );
  assert.match(refused, /role="alert"[^>]*>Team roster changed; review it before trying again\./, "the roster_conflict refusal is visible, not swallowed");
  assert.doesNotMatch(refused, /data-testid="team-join-code"/, "a refused issue leaves no code on screen");
});

test("B1: the control survives a phone width, and the Agents settings column renders the same one at every width", () => {
  const html = renderToStaticMarkup(<TeamJoinCodeControl joinCode={CODE} issuing={false} error={null} onIssue={() => {}} />);
  // At 375px the row cannot fit the sentence and the button side by side, so it
  // must wrap rather than overflow, and the code is one unbroken 100+ character
  // token, so it must break inside itself.
  assert.match(html, /class="[^"]*flex-wrap[^"]*"/, "the label and the button wrap when they cannot share a line");
  assert.match(html, /class="[^"]*min-w-0[^"]*flex-1[^"]*basis-48[^"]*"/, "the sentence may shrink below its content width");
  assert.match(html, /data-testid="team-join-code" class="[^"]*break-all[^"]*"/, "the code breaks instead of scrolling the page");
  // The shared Button keeps its own label on one line, which is a short one here;
  // nothing this control adds may pin a width the phone does not have.
  assert.doesNotMatch(html, /\b(w-\[|min-w-\[|max-w-none|overflow-x-auto)/, "nothing here forces a width the phone does not have");

  const panel = source("./TeamStatusPanel.tsx");
  assert.match(panel, /<TeamJoinCodeControl joinCode=\{joinCode\} issuing=\{issuing\} error=\{joinCodeError\} onIssue=\{\(\) => void issueJoinCode\(\)\} \/>/);
  assert.doesNotMatch(panel, /\b(sm|md|lg|xl):/, "one panel serves both widths, with no width-conditional branch");

  const agents = source("./AgentsView.tsx");
  const teamBlock = agents.match(/taskControlTransport === "telegram" && teamEnabled && \([\s\S]*?\)\}/);
  assert.ok(teamBlock, "AgentsView renders the Team panels");
  assert.match(teamBlock[0], /<TeamStatusPanel \/>/);
  assert.doesNotMatch(teamBlock[0], /\b(sm|md|lg|xl):/, "the Team block is one settings column at every width");
});

test("B1: the client method posts to the Team join-code route, and the panel republishes the roster it changed", () => {
  const api = source("../../lib/workspacesApi.ts");
  const method = api.match(/reissueTeamJoinCode\(serverUrl:string\)\{[^\n]*\}/);
  assert.ok(method, "workspacesApi must expose reissueTeamJoinCode");
  assert.match(method[0], /"\/api\/task-control\/team\/join-code"/);
  assert.match(method[0], /method:"POST"/);
  assert.match(method[0], /\{teamId:string;joinCode:string\}/);

  const panel = source("./TeamStatusPanel.tsx");
  assert.match(panel, /window\.dispatchEvent\(new Event\("team-roster-changed"\)\)/, "an issued code republished the roster, so readers of it are told");
  assert.match(panel, /window\.addEventListener\("team-roster-changed", read\)/, "the panel keeps listening on the same convention");
});
