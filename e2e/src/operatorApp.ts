import type { TelegramLiveStatus } from "@agent-console/shared";

/*
 * Read-only observation of the operator's own running app on port 4000, so a T3 run can prove it
 * kept polling its own bot undisturbed (docs/e2e-scenarios/h6.md S-H6-19). Only GET requests.
 */

export interface OperatorSample {
  at: number;
  state: TelegramLiveStatus["state"];
  botId: string | null;
  lastPollAt: string | null;
  lastError: string | null;
}

export async function sampleOperatorApp(): Promise<OperatorSample | null> {
  try {
    const response = await fetch("http://127.0.0.1:4000/api/task-control/telegram", { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const { status } = (await response.json()) as { status: TelegramLiveStatus };
    return { at: Date.now(), state: status.state, botId: status.bot?.id ?? null, lastPollAt: status.lastPollAt, lastError: status.lastError };
  } catch {
    return null;
  }
}

/** Problems with a series of samples; empty when the operator's app polled its own bot throughout. */
export function coexistenceProblems(samples: Array<OperatorSample | null>, testBotId: string): string[] {
  const [first] = samples;
  if (!first || first.state !== "polling") return ["coexistence unproven: operator app not polling at the start of the run"];
  const problems: string[] = [];
  samples.forEach((sample, index) => {
    if (!sample) problems.push(`sample ${index + 1}: the operator app did not answer`);
    else if (sample.state !== "polling") problems.push(`sample ${index + 1}: the operator app was ${sample.state}`);
    else if (sample.botId !== first.botId || sample.botId === testBotId) problems.push(`sample ${index + 1}: the operator app reported bot ${sample.botId}`);
    else if (/conflict|another process/i.test(sample.lastError ?? "")) problems.push(`sample ${index + 1}: the operator app reported a polling conflict`);
  });
  const polls = samples.map((sample) => sample?.lastPollAt).filter((value): value is string => Boolean(value));
  if (samples.length > 1 && new Set(polls).size < 2) problems.push("the operator app's lastPollAt did not advance during the run");
  return problems;
}
