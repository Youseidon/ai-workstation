import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/* Scripted fake agent (docs/e2e-harness-plan.md 4.3): queue scenarios, read what the fake did. */

export const FAKE_GROK_BIN = resolve(import.meta.dirname, "../../fake-provider/bin/grok");

export type FakeBehaviour = "done" | "block-on-decision" | "fail" | "hang-until-stopped" | "crash-after-spawn" | "consume-answer";

export interface FakeScenario {
  behavior: FakeBehaviour;
  remark?: string;
  reason?: string;
  humanAction?: string;
  expectInContext?: string;
  verificationSummary?: string;
  ignoreSigint?: boolean;
  skipStatus?: boolean;
  /** Shim channel: the kind of the remark posted before the status (default DECISION_NEEDED when blocking). */
  remarkKind?: "BLOCKER" | "DECISION_NEEDED" | "PROGRESS";
  malformedStatus?: boolean;
  text?: string;
  /** Blocking scenarios: the options reported with the BLOCKED status (L3 A2). */
  options?: Array<{ label: string; advantages?: string[]; disadvantages?: string[] }>;
}

export interface FakeLogEntry {
  event: string;
  behavior?: string;
  /** Which reporting channel the prompt gave this run (server/src/runService.ts, executeChannel). */
  channel?: "shim" | "offline" | "custom";
  /** The launcher the prompt named, on the shim channel. */
  shim?: string | null;
  /** `exec` entries: a launcher call the fake is about to make. `shim` entries: how it ended. */
  command?: string;
  args?: string[];
  stderr?: string;
  status?: number | string;
  code?: number | null;
  signal?: string | null;
  containsExpected?: boolean | null;
  [key: string]: unknown;
}

export class FakeProvider {
  readonly dir: string;

  constructor(root: string) {
    this.dir = join(root, "fake-provider");
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "queue.json"), "[]");
  }

  /** Replaces the queue; each run takes the next scenario. */
  queue(...scenarios: FakeScenario[]): void {
    writeFileSync(join(this.dir, "queue.json"), JSON.stringify(scenarios));
  }

  log(): FakeLogEntry[] {
    const file = join(this.dir, "fake-provider.log");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeLogEntry);
  }

  /** Server environment and settings that route Grok to this fake. */
  static serverEnv(root: string): Record<string, string> {
    return { FAKE_PROVIDER_DIR: join(root, "fake-provider") };
  }

  /**
   * `live` leaves the console reachable, so the server gives the run the
   * `agent-step` launcher; `inline` sandboxes the provider, so it has no route to
   * the console and the server gives it the offline protocol instead. The names
   * are the settings, not the channel: the fake logs the channel it was handed.
   */
  static settings(path: "live" | "inline"): Record<string, unknown> {
    return {
      "claude.enabled": false,
      "codex.enabled": false,
      "cursor.enabled": false,
      "grok.enabled": true,
      "grok.binary": FAKE_GROK_BIN,
      "grok.assumeAuthenticated": true,
      "hostAccess": false,
      // Sandbox off lets the provider reach the local Progress API, so the run is
      // given the launcher; a workspace sandbox leaves it no route, so the run is
      // given the offline protocol and reports in its final message.
      "grok.sandboxMode": path === "live" ? "off" : "workspace",
    };
  }
}
