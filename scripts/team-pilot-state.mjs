#!/usr/bin/env node

// Read-only snapshot of one pilot instance's Team state, for resuming a test
// session without re-deriving everything. Usage:
//   node scripts/team-pilot-state.mjs [path-to-.agent-console/console.sqlite]

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const dbPath = resolve(process.argv[2] ?? ".agent-console/console.sqlite");
const db = new DatabaseSync(dbPath, { readOnly: true });
const all = (sql, ...args) => db.prepare(sql).all(...args);
const line = (label, value) => console.log(`${label.padEnd(18)} ${value}`);

console.log(`# Team pilot state - ${dbPath}\n`);

const roster = all("SELECT team_id,group_chat_id,remote_url,record_json FROM team_roster")[0];
if (roster === undefined) console.log("roster             none (no team created or joined)");
else {
  line("team", roster.team_id);
  line("group chat", roster.group_chat_id);
  line("remote", roster.remote_url);
  for (const member of JSON.parse(roster.record_json).members) {
    line("member", `${member.workstationLabel} · @${member.botUsername} · user ${member.telegramUserId}`);
  }
}

console.log("\n## Actors");
for (const actor of all("SELECT transport_user_id,chat_id,topic_id,label,enabled FROM task_control_actor ORDER BY rowid")) {
  line(actor.topic_id === null ? "personal" : "group", `${actor.label} · user ${actor.transport_user_id} · chat ${actor.chat_id} · enabled ${actor.enabled}`);
}

console.log("\n## Items and grants");
const links = all("SELECT item_id,prompt_id,role FROM item_link ORDER BY rowid");
if (links.length === 0) console.log("(no item threads open)");
for (const link of links) {
  const prompt = all("SELECT title,status FROM prompt WHERE id=?", link.prompt_id)[0];
  line("item", `${link.item_id} · prompt ${link.prompt_id} · ${prompt?.title ?? "?"} · ${prompt?.status ?? "?"} · ${link.role}`);
  const grants = all("SELECT person_id,capability,revoked_at FROM item_grant WHERE item_id=? ORDER BY granted_at", link.item_id);
  for (const grant of grants) line("  grant", `${grant.capability} → ${grant.person_id}${grant.revoked_at === null ? "" : ` (revoked ${grant.revoked_at})`}`);
  if (grants.length === 0) line("  grant", "none");
}

console.log("\n## Open actions (unexpired)");
const now = new Date().toISOString();
const actions = all("SELECT ref,action,prompt_id,item_id,expires_at FROM task_control_action WHERE expires_at>? ORDER BY created_at", now);
if (actions.length === 0) console.log("(none live)");
for (const action of actions) line("action", `${action.action} · prompt ${action.prompt_id} · item ${action.item_id ?? "-"} · expires ${action.expires_at}`);

console.log("\n## Last 8 group messages");
const chat = roster?.group_chat_id ?? "";
for (const row of all("SELECT id,state,operation,target_outbox_id,created_at,payload_json FROM telegram_outbox WHERE chat_id=? ORDER BY id DESC LIMIT 8", chat).reverse()) {
  let text = "";
  try {
    const payload = JSON.parse(row.payload_json);
    text = (payload.text ?? payload.kind ?? "").split("\n")[0].slice(0, 58);
  } catch { text = "(unparsed)"; }
  console.log(`  ${String(row.id).padStart(4)} ${row.state.padEnd(6)} ${row.operation}${row.target_outbox_id === null ? "" : `→${row.target_outbox_id}`} ${row.created_at.slice(11, 19)} ${text}`);
}

const failed = all("SELECT count(*) c FROM telegram_outbox WHERE state='FAILED'")[0].c;
if (failed > 0) console.log(`\n!! ${failed} FAILED outbox rows - check B8/B9 in the bug log.`);
