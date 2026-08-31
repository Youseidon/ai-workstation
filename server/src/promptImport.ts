import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { PromptImportPreview, PromptStatus } from "@agent-console/shared";
import { WorkspaceError } from "./workspaces.ts";

export interface ImportedPrompt {
  key: string; title: string; content: string; status: PromptStatus;
  completedAt: string | null; result: string; isGate: boolean;
}
export interface ImportedSuite { key: string; name: string; prompts: ImportedPrompt[] }
export interface ImportedGate { code: string; promptKey: string; name: string; description: string }
export interface ImportedProgram {
  key: string; name: string; overview: string; workspaceDescription: string;
  suites: ImportedSuite[]; dependencies: Array<{ promptKey: string; dependsOnKey: string }>;
  gates: ImportedGate[]; warnings: string[];
}

const STATUSES = new Set<PromptStatus>(["TODO", "IN_PROGRESS", "DONE", "BLOCKED", "SKIPPED"]);

function cells(line: string): string[] { return line.split("|").slice(1, -1).map(cell => cell.trim()); }
function plain(value: string): string { return value.replace(/\*\*/g, "").replace(/`/g, "").trim(); }
function suiteName(directory: string): string {
  return directory.replace(/^s\d+-/i, "").split("-").map((word, index) => index === 0 ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word).join(" ");
}
function promptText(raw: string): { key: string; title: string; content: string } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.shift()?.match(/^#\s+([A-Z][A-Z0-9]*-\d+[A-Z]?)\s+[—-]\s+(.+)$/);
  if (!heading) throw new WorkspaceError(422, "invalid_prompt", "Prompt file must start with '# ID — Title'");
  while (lines[0]?.trim() === "") lines.shift();
  if (lines[0]?.startsWith(">") && lines[0].includes("PREAMBLE.md")) {
    while (lines[0]?.startsWith(">")) lines.shift();
    while (lines[0]?.trim() === "") lines.shift();
  }
  return { key: heading[1]!, title: heading[2]!.trim(), content: lines.join("\n").trim() };
}
function workspaceContext(raw: string): string {
  const normalized=raw.replace(/\r\n/g,"\n");
  const separator=normalized.indexOf("\n---\n");
  let content=(separator>=0?normalized.slice(separator+5):normalized).trim();
  const before=content.indexOf("## Before you start any prompt");
  if(before>=0) content=`${content.slice(0,before).trim()}\n\n## Before you start any prompt\n\n- The orchestrator enforces saved prompt dependencies before a run can start.\n- Read every input named by the selected work item before writing.\n- If an assumption no longer matches the repository, stop and report the discrepancy rather than improvising.\n- Execute one work item per session and report verification honestly. Prompt status and results are maintained in the workspace library.`;
  return `# MaterioForge backend transition — standing instructions\n\n${content}`;
}
function programOverview(raw:string):string {
  const body=raw.replace(/\r\n/g,"\n").replace(/^#.*\n+/,"");
  return body.split(/\n\n/)[0]?.trim()??"";
}
function dependencies(value: string): string[] {
  if (value === "—" || value === "") return [];
  const range = value.match(/(S\d+)-(\d+)\s+…\s+S\d+-(\d+)\s+all DONE/i);
  if (range) {
    const prefix=range[1]!; const start=Number(range[2]); const end=Number(range[3]);
    return Array.from({length:end-start+1},(_,index)=>`${prefix}-${String(start+index).padStart(2,"0")}`);
  }
  return [...value.matchAll(/S\d+-\d+[A-Z]?/g)].map(match=>match[0]);
}

export function inspectPromptPack(rootPath: unknown, programKey: unknown): { pack: ImportedProgram; preview: PromptImportPreview } {
  if (typeof rootPath !== "string" || rootPath.trim() === "") throw new WorkspaceError(422,"validation_error","rootPath is required");
  if (typeof programKey !== "string" || programKey.trim() === "") throw new WorkspaceError(422,"validation_error","programKey is required");
  const root=resolve(rootPath); const programDir=join(root,"programs",programKey);
  if (!existsSync(programDir) || !statSync(programDir).isDirectory()) throw new WorkspaceError(422,"invalid_import","Program directory does not exist");
  const manifest=JSON.parse(readFileSync(join(programDir,"PROGRAM.json"),"utf8")) as {id?:unknown;title?:unknown;tracker?:unknown;preamble?:unknown};
  if (manifest.id!==programKey || typeof manifest.title!=="string") throw new WorkspaceError(422,"invalid_import","PROGRAM.json does not match the requested program");
  const tracker=readFileSync(join(programDir,typeof manifest.tracker==="string"?manifest.tracker:"TRACKER.md"),"utf8");
  const preamble=workspaceContext(readFileSync(join(programDir,typeof manifest.preamble==="string"?manifest.preamble:"PREAMBLE.md"),"utf8"));
  const overview=programOverview(readFileSync(join(programDir,"README.md"),"utf8"));
  const trackerRows=new Map<string,{status:PromptStatus;completedAt:string|null;result:string;deps:string[]}>();
  for(const line of tracker.split(/\r?\n/)){
    if(!/^\|\s*S\d+-/.test(line)) continue; const row=cells(line); const key=plain(row[0]??"").match(/S\d+-\d+[A-Z]?/)?.[0];
    const status=plain(row[3]??"").replace(/ /g,"_") as PromptStatus; if(!key||!STATUSES.has(status)) continue;
    trackerRows.set(key,{status,completedAt:/^\d{4}-\d{2}-\d{2}$/.test(row[4]??"")?`${row[4]}T00:00:00.000Z`:null,result:row.slice(5).join("|").trim(),deps:dependencies(plain(row[2]??""))});
  }
  const gateDescriptions=new Map<string,{code:string;name:string;description:string}>();
  for(const line of tracker.split(/\r?\n/)){
    if(!/^\|\s*\*\*G\d+/.test(line)) continue; const row=cells(line); const code=plain(row[0]??""); const promptCell=plain(row[1]??""); const key=promptCell.match(/S\d+-\d+[A-Z]?/)?.[0];
    if(key) gateDescriptions.set(key,{code,name:promptCell.replace(key,"").trim(),description:row.slice(2).join("|").trim()});
  }
  const suites:ImportedSuite[]=[]; const promptKeys=new Set<string>();
  const directories=readdirSync(programDir,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^s\d+-/.test(entry.name)).sort((a,b)=>Number(a.name.match(/^s(\d+)/)?.[1])-Number(b.name.match(/^s(\d+)/)?.[1]));
  for(const directory of directories){
    const key=`S${Number(directory.name.match(/^s(\d+)/)?.[1])}`; const prompts:ImportedPrompt[]=[];
    const files=readdirSync(join(programDir,directory.name)).filter(file=>/^[A-Z][A-Z0-9]*-\d+[A-Z]?.*\.md$/.test(file)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    for(const file of files){ const parsed=promptText(readFileSync(join(programDir,directory.name,file),"utf8")); const state=trackerRows.get(parsed.key)??{status:"TODO" as const,completedAt:null,result:"",deps:[]}; promptKeys.add(parsed.key); prompts.push({...parsed,status:state.status,completedAt:state.completedAt,result:state.result,isGate:gateDescriptions.has(parsed.key)}); }
    suites.push({key,name:suiteName(directory.name),prompts});
  }
  const warnings:string[]=[]; const deps:Array<{promptKey:string;dependsOnKey:string}>=[];
  for(const [promptKey,state] of trackerRows){ if(!promptKeys.has(promptKey)) continue; for(const dependsOnKey of state.deps){ if(promptKeys.has(dependsOnKey)) deps.push({promptKey,dependsOnKey}); else warnings.push(`${promptKey} depends on missing prompt ${dependsOnKey}`); } }
  const gates:ImportedGate[]=[...gateDescriptions.entries()].filter(([key])=>promptKeys.has(key)).map(([promptKey,gate])=>({promptKey,...gate}));
  if(tracker.includes("S6-00-module-playbook.md`) lost")||tracker.includes("file on disk is the stale")) warnings.push("The tracker reports that S6-00 on disk may be stale; its current text will be imported as-is.");
  const pack:ImportedProgram={key:programKey,name:manifest.title,overview,workspaceDescription:preamble,suites,dependencies:deps,gates,warnings};
  const counts=Object.fromEntries([...STATUSES].map(status=>[status,0])) as Record<PromptStatus,number>; for(const suite of suites)for(const prompt of suite.prompts)counts[prompt.status]++;
  return {pack,preview:{programKey,programName:manifest.title,suites:suites.length,prompts:promptKeys.size,dependencies:deps.length,gates:gates.length,statuses:counts,workspaceDescriptionCharacters:preamble.length,warnings}};
}
