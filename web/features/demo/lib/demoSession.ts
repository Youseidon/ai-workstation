import type { DemoSeedProgress } from "@hydra/shared";
import { readProgressLines, revealDelay } from "./demoLaunch";

export interface DemoSession {
  /** Replays every line revealed so far, then delivers new ones as they are revealed. */
  subscribe(listener: (line: DemoSeedProgress) => void): () => void;
}

/**
 * Starts one demo launch. It is created from the click, outside React,
 * because the request creates an account: an effect that StrictMode runs
 * twice, or a remount, must never make a second one. The component only
 * subscribes, and a late subscriber is caught up from the history.
 */
export function startDemoSession(open: () => Promise<ReadableStream<Uint8Array>>, options: { reducedMotion: boolean; sleep?: (ms: number) => Promise<void> }): DemoSession {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const history: DemoSeedProgress[] = [];
  const listeners = new Set<(line: DemoSeedProgress) => void>();
  const queue: DemoSeedProgress[] = [];
  let draining = false;
  let settled = false;

  const reveal = (line: DemoSeedProgress) => {
    if (settled) return;
    if (line.step === "ready") settled = true;
    history.push(line);
    for (const listener of listeners) listener(line);
  };
  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const line = queue.shift()!;
      reveal(line);
      if (line.state === "error") { queue.length = 0; break; }
      await sleep(revealDelay(line, options.reducedMotion));
    }
    draining = false;
  };
  const fail = (detail: string) => { queue.push({ step: "ready", state: "error", detail }); void drain(); };

  void (async () => {
    try {
      const reader = (await open()).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawReady = false;
      for (;;) {
        const { value, done } = await reader.read();
        const parsed = readProgressLines(done ? `${buffer}${decoder.decode()}\n` : buffer + decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        sawReady ||= parsed.lines.some(line => line.step === "ready");
        // An error line from the server ends the launch; anything after it is noise.
        queue.push(...parsed.lines);
        void drain();
        if (done) break;
      }
      if (!sawReady) fail("The connection closed before the demo was ready.");
    } catch (reason) {
      fail(reason instanceof Error ? reason.message : "The demo could not be started.");
    }
  })();

  return {
    subscribe(listener) {
      for (const line of history) listener(line);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
