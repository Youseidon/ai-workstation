import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FAKE_GROK_BIN } from "./drivers/fakeProvider.ts";

// S-H2-03: the fake speaks the recorded Grok stream format, checked through the server's real mapper.

const recorded = readFileSync(resolve(import.meta.dirname, "../contracts/grok-1.0.5-streaming-json.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

type Mapper = { map(value: unknown): Array<{ type: string; payload: Record<string, unknown> }>; settled: boolean };

async function mapper(): Promise<Mapper> {
  const modulePath: string = resolve(import.meta.dirname, "../../server/src/adapters/grok.ts");
  const { GrokAdapter } = (await import(modulePath)) as { GrokAdapter: new () => { createMapper(): Mapper } };
  return new GrokAdapter().createMapper();
}

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, shape((value as Record<string, unknown>)[key])]));
  return typeof value;
}

function fakeStream(): Array<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "fake-grok-contract-"));
  try {
    writeFileSync(join(dir, "queue.json"), JSON.stringify([{ behavior: "done", text: "The repository has one file." }]));
    const result = spawnSync(FAKE_GROK_BIN, ["--output-format", "streaming-json", "--cwd", dir, "-p", "Summarise the repository."], { env: { ...process.env, FAKE_PROVIDER_DIR: dir }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("S-H2-03: every event the fake emits has a recorded real counterpart with the same shape", () => {
  const recordedShapes = new Map<string, unknown[]>();
  for (const event of recorded) recordedShapes.set(String(event.type), [...(recordedShapes.get(String(event.type)) ?? []), shape(event)]);
  for (const event of fakeStream()) {
    const type = String(event.type);
    if (type === "system") continue; // Real grok also emits a session init; the mapper treats it as status only.
    const candidates = recordedShapes.get(type);
    assert.ok(candidates, `fake emitted ${type}, which the recorded stream never contains`);
    assert.ok(candidates.some((candidate) => JSON.stringify(candidate) === JSON.stringify(shape(event))), `fake ${type} shape ${JSON.stringify(shape(event))} matches no recorded shape`);
  }
});

test("S-H2-03: the real mapper turns the recorded and fake streams into the same kind of run", async () => {
  const summarize = async (events: Array<Record<string, unknown>>) => {
    const instance = await mapper();
    const mapped = events.flatMap((event) => instance.map(event));
    const result = mapped.find((event) => event.type === "result");
    return { settled: instance.settled, resultState: result?.payload.state, hasUsage: Boolean(result?.payload.usage), finalText: result?.payload.text };
  };
  const real = await summarize(recorded);
  const fake = await summarize(fakeStream());
  assert.deepEqual(fake, real);
});

test("S-H2-01 (T0 part): --version answers like the real binary", () => {
  const result = spawnSync(FAKE_GROK_BIN, ["--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout.split("\n")[0] ?? "", /^grok \d+\.\d+\.\d+$/);
});
