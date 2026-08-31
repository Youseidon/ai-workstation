const USEFUL_SECTION = /^(objective|scope|verification\b|acceptance\b|exit\b|constraints|rules\b|money rules\b|rounding\b|snapshots\b|gst verification\b|cross-module boundaries\b|financial-records deletion\b)/i;

/** Keep decision and verification material while dropping report templates and repeated policy prose. */
export function compactWorkItem(content:string):string {
  const lines=content.trim().split(/\r?\n/);const intro:string[]=[];const sections:string[][]=[];let current:string[]|null=null;
  for(const line of lines){const heading=line.match(/^##\s+(.+)$/);if(heading){current=USEFUL_SECTION.test(heading[1]!.trim())?[line]:null;if(current)sections.push(current);continue;}if(current)current.push(line);else if(sections.length===0&&!/^#\s/.test(line))intro.push(line);}
  const selected=[intro.join("\n").trim(),...sections.map(section=>section.join("\n").trim())].filter(Boolean);
  return selected.join("\n\n");
}

export function uniqueCommands(contents:string[]):string[] {
  const seen=new Set<string>();const commands:string[]=[];
  for(const content of contents)for(const match of content.matchAll(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/gi))for(const line of match[1]!.split(/\r?\n/)){const command=line.trim();if(command===""||command.startsWith("#")||seen.has(command))continue;seen.add(command);commands.push(command);}
  return commands;
}

/* -------------------------------------------------------------------------- */
/* Report parsing                                                              */
/* -------------------------------------------------------------------------- */

import type { SuiteVerificationCheck, SuiteVerificationItem, SuiteVerificationVerdict } from "@agent-console/shared";

/** Maps whatever word the agent used onto one of our four outcomes. */
export function normalizeCheck(value: string): SuiteVerificationCheck | null {
  const text = value.toUpperCase();
  // FAIL before PASS: "PASS/FAIL" style cells and "FAILED TO PASS" must not
  // read as a pass. Absence of evidence is UNVERIFIED, not failure.
  if (/\bFAIL(ED|URE)?\b|\b✗\b|\bNO\b/.test(text)) return "FAILED";
  if (/\bWARN(ING)?\b|\bPARTIAL\b/.test(text)) return "WARNING";
  if (/\bUNVERIFIED\b|\bUNKNOWN\b|\bN\/?A\b|\bSKIP(PED)?\b|\bNOT (RUN|CHECKED)\b/.test(text)) return "UNVERIFIED";
  if (/\bPASS(ED|ES)?\b|\bVERIFIED\b|\bOK\b|\b✓\b/.test(text)) return "VERIFIED";
  return null;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const SEPARATOR = /^\|?[\s:-]*-{2,}[\s:|-]*\|?$/;

/**
 * Pulls the per-item results out of the agent's markdown report.
 *
 * Written to be forgiving: the column order, the header wording and the exact
 * status word all vary between providers and between runs. Anything that cannot
 * be parsed is simply not claimed as an item — the full report is stored
 * verbatim either way, so a parser miss loses presentation, never evidence.
 */
export function parseReportItems(markdown: string): SuiteVerificationItem[] {
  const lines = markdown.split(/\r?\n/);
  const items: SuiteVerificationItem[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.includes("|")) continue;
    const header = splitRow(line).map((cell) => cell.toLowerCase());
    if (header.length < 2) continue;
    const next = lines[index + 1];
    if (next === undefined || !SEPARATOR.test(next.trim())) continue;

    // Locate the columns by meaning, not position.
    const statusColumn = header.findIndex((cell) => /status|result|pass|verdict|outcome|check/.test(cell));
    const itemColumn = header.findIndex((cell) => /item|work|prompt|id|key|task|criterion/.test(cell));
    const evidenceColumn = header.findIndex((cell) => /evidence|finding|note|detail|observ/.test(cell));
    const commandColumn = header.findIndex((cell) => /command|check|how|verif/.test(cell));
    if (statusColumn === -1) continue;

    for (let row = index + 2; row < lines.length; row += 1) {
      const body = lines[row]!;
      if (!body.includes("|") || body.trim() === "") break;
      const cells = splitRow(body);
      if (cells.length < 2 || SEPARATOR.test(body.trim())) continue;
      const check = normalizeCheck(cells[statusColumn] ?? "");
      if (check === null) continue;
      const label = (itemColumn === -1 ? cells[0] : cells[itemColumn]) ?? "";
      const title = label.replace(/[*`]/g, "").trim();
      if (title === "") continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        promptId: null,
        promptKey: extractKey(title),
        title,
        check,
        evidence: (evidenceColumn === -1 ? "" : cells[evidenceColumn] ?? "").replace(/[*`]/g, "").trim(),
        commands: (commandColumn === -1 || commandColumn === statusColumn ? "" : cells[commandColumn] ?? "")
          .replace(/[*`]/g, "")
          .trim(),
      });
    }
  }
  return items;
}

/** `S0-03` out of `S0-03 — C# contract emitter`, when the agent used one. */
export function extractKey(title: string): string | null {
  const match = title.match(/\b([A-Z]{1,3}\d+(?:[-.]\d+)+)\b/);
  return match?.[1] ?? null;
}

/**
 * The overall verdict. An explicit statement by the agent wins; otherwise it is
 * derived from the items, where anything not positively verified is not a pass.
 */
export function deriveVerdict(
  markdown: string,
  items: SuiteVerificationItem[],
): SuiteVerificationVerdict {
  const stated = markdown.match(
    /(?:overall|suite|final)[^\n]{0,40}?verdict[^\n]{0,20}?\b(PASS|FAIL|WARNING|WARN)\b/i,
  );
  if (stated) return stated[1]!.toUpperCase() === "WARN" ? "WARNING" : (stated[1]!.toUpperCase() as SuiteVerificationVerdict);
  if (items.length === 0) return "WARNING";
  if (items.some((item) => item.check === "FAILED")) return "FAIL";
  if (items.some((item) => item.check === "WARNING" || item.check === "UNVERIFIED")) return "WARNING";
  return "PASS";
}

export function summarize(items: SuiteVerificationItem[]) {
  return {
    total: items.length,
    verified: items.filter((item) => item.check === "VERIFIED").length,
    warnings: items.filter((item) => item.check === "WARNING").length,
    failed: items.filter((item) => item.check === "FAILED").length,
    unverified: items.filter((item) => item.check === "UNVERIFIED").length,
  };
}
