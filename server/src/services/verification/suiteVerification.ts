const USEFUL_SECTION = /^(objective|goal|purpose|scope|context|background|requirements?|deliverables?|definition of done|acceptance\b|verification\b|validation\b|testing\b|exit\b|success\b|constraints|rules\b|invariants?\b|non-?goals?\b|out of scope)/i;

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

export function dossierHeading(
  suite: { key: string | null; name: string },
  scope: { promptKey: string | null; title: string } | null = null,
): string {
  const suiteLabel = `${suite.key ?? suite.name} — ${suite.name}`;
  if (scope === null) return `# Independent verification: ${suiteLabel}`;
  const itemLabel = scope.promptKey === null ? scope.title : `${scope.promptKey} — ${scope.title}`;
  return `# Independent verification: ${suiteLabel} › ${itemLabel}`;
}

import type { SuiteVerificationCheck, SuiteVerificationItem, SuiteVerificationVerdict } from "@hydra/shared";

export function normalizeCheck(value: string): SuiteVerificationCheck | null {
  const text = value.toUpperCase();
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

export function extractKey(title: string): string | null {
  const match = title.match(/\b([A-Z]{1,3}\d+(?:[-.]\d+)+)\b/);
  return match?.[1] ?? null;
}

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
