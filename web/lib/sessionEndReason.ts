import type { NormalizedEvent } from "@agent-console/shared";

function eventText(events: NormalizedEvent[]): string {
  return events
    .flatMap((event) => {
      if (event.type === "error") return [event.payload.message, event.payload.detail ?? ""];
      if (event.type === "result") return [event.payload.text ?? ""];
      if (event.type === "assistant_text" && event.payload.kind === "message") return [event.payload.text];
      return [];
    })
    .join("\n")
    .toLowerCase();
}

export function sessionEndReason(state: string, events: NormalizedEvent[]): string | null {
  const terminal = state.trim().toUpperCase();
  if (terminal !== "ERROR" && terminal !== "INTERRUPTED") return null;
  if (terminal === "INTERRUPTED") return "stopped";

  const text = eventText(events);
  if (/out of (?:extra )?usage|rate[_ -]?limit|usage limit|quota/.test(text)) return "usage limit";
  if (/login expired|not authenticated|authentication|sign in/.test(text)) return "authentication";
  if (/network|econn|dns|fetch failed|socket/.test(text)) return "network failure";
  if (/process exited|run failed|code [1-9]/.test(text)) return "provider process";
  return "provider failure";
}
