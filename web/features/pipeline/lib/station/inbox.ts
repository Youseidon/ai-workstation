import type { OperationsPrompt, OperationsSuite } from "@hydra/shared";
import { LABEL } from "../status";
import { needsYou } from "./tree";

export interface InboxEntry {
  suite: OperationsSuite;
  item: OperationsPrompt;
  /** What it is waiting for, one line. */
  ask: string;
}

/** Every item across these suites that is waiting on the operator, oldest first. */
export function collectInbox(suites: OperationsSuite[]): InboxEntry[] {
  const entries: InboxEntry[] = [];
  const walk = (suite: OperationsSuite, list: OperationsPrompt[]) => {
    for (const item of list) {
      if (needsYou(item)) {
        const ask =
          item.humanIntervention?.status === "PENDING"
            ? item.humanIntervention.requiredAction
            : item.latestIntervention ??
              (item.prompt.recoverable ? "The run stopped without posting a status." : LABEL[item.operationalState]);
        entries.push({ suite, item, ask });
      }
      walk(suite, item.children);
    }
  };
  for (const suite of suites) walk(suite, suite.prompts);
  return entries.sort((a, b) => a.item.lastActivityAt.localeCompare(b.item.lastActivityAt));
}

