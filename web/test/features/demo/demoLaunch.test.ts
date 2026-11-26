import assert from "node:assert/strict";
import test from "node:test";
import type { DemoSeedProgress } from "@hydra/shared";
import { DEMO_STAGES, INITIAL_LAUNCH, demoTimeLeft, launchReducer, litHeads, readProgressLines, revealDelay, stageIndex } from "../../../features/demo/lib/demoLaunch";
import { startDemoSession } from "../../../features/demo/lib/demoSession";

test("progress lines are parsed across chunk boundaries and junk is skipped", () => {
  const first = readProgressLines('{"step":"account","state":"done","detail":"demo-amber-1a2b3c"}\n{"step":"runtime","sta');
  assert.deepEqual(first.lines.map(line => line.step), ["account"]);
  const second = readProgressLines(`${first.rest}te":"active","detail":"x"}\nnot json\n{"step":"git"}\n`);
  assert.deepEqual(second.lines, [{ step: "runtime", state: "active", detail: "x" }]);
  assert.equal(second.rest, "");
});

test("every stage wakes heads in order and the mark is whole only once all stages land", () => {
  const all = new Set(DEMO_STAGES.map(stage => stage.step));
  assert.equal(litHeads(all).length, 6);
  assert.deepEqual(litHeads(new Set(["account", "runtime", "folder"])), ["claude"]);
  assert.equal(stageIndex("ready"), DEMO_STAGES.length);
});

test("the reducer records the account, folder and failures the server reports", () => {
  const lines: DemoSeedProgress[] = [
    { step: "account", state: "done", detail: "demo-tide-abcdef" },
    { step: "folder", state: "active", detail: "/home/u/hydra-demo/demo-tide-abcdef/kettle" },
    { step: "folder", state: "done", detail: "/home/u/hydra-demo/demo-tide-abcdef/kettle" },
  ];
  const state = lines.reduce(launchReducer, INITIAL_LAUNCH);
  assert.equal(state.username, "demo-tide-abcdef");
  assert.match(state.folder, /kettle$/);
  assert.equal(state.log.length, 2, "an active line is replaced by its done line");
  assert.equal(state.log[1]?.tone, "done");
  assert.ok(state.completed.has("folder"));
  assert.equal(launchReducer(state, { step: "ready", state: "error", detail: "boom" }).error, "boom");
  assert.equal(launchReducer(state, { step: "ready", state: "done", detail: "1" }).ready, true);
});

test("pacing holds finished stages longer and nearly vanishes with reduced motion", () => {
  const done: DemoSeedProgress = { step: "git", state: "done", detail: "" };
  assert.ok(revealDelay(done, false) > revealDelay({ ...done, state: "active" }, false));
  assert.ok(revealDelay(done, true) <= 150);
  assert.equal(revealDelay({ ...done, state: "error" }, false), 0);
});

test("demo expiry reads as hours, then minutes", () => {
  const now = Date.parse("2026-11-26T10:00:00Z");
  assert.equal(demoTimeLeft("2026-11-27T09:30:00Z", now), "23 h left");
  assert.equal(demoTimeLeft("2026-11-26T10:40:00Z", now), "40 min left");
  assert.equal(demoTimeLeft("2026-11-26T09:00:00Z", now), "expiring now");
  assert.equal(demoTimeLeft(undefined, now), null);
});

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17)); controller.close(); } });
}

test("a session opens the request once and replays its history to late subscribers", async () => {
  let opened = 0;
  const session = startDemoSession(async () => { opened++; return streamOf('{"step":"account","state":"done","detail":"demo-x-000000"}\n{"step":"ready","state":"done","detail":"1"}\n'); }, { reducedMotion: true, sleep: async () => {} });
  const first: string[] = [];
  const stop = session.subscribe(line => first.push(line.step));
  await new Promise(resolve => setTimeout(resolve, 20));
  stop();
  const late: string[] = [];
  session.subscribe(line => late.push(line.step));
  assert.equal(opened, 1);
  assert.deepEqual(first, ["account", "ready"]);
  assert.deepEqual(late, ["account", "ready"]);
});

test("a stream that ends without ready becomes an error the screen can show", async () => {
  const session = startDemoSession(async () => streamOf('{"step":"account","state":"done","detail":"demo-x-000000"}\n'), { reducedMotion: true, sleep: async () => {} });
  const seen: DemoSeedProgress[] = [];
  session.subscribe(line => seen.push(line));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(seen.at(-1)?.state, "error");
});
