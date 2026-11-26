import type { ProcessIdentity } from "../contracts/execution.ts";
import { readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync=promisify(execFile);

export function processIdentity(pid:number,unitName:string|null=null,containment="process-group"): ProcessIdentity {
  if(process.platform!=="linux") throw new Error("Durable process identity requires Linux /proc or a managed unit");
  const stat=readFileSync(`/proc/${pid}/stat`,"utf8");
  const fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
  return {pid,startTicks:fields[19]!,bootId:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),unitName,containment};
}

export async function writerLiveness(identity:ProcessIdentity|null, runId?:string):Promise<"alive"|"dead"|"unknown"> {
  if(identity?.unitName || (!identity && runId)) {
    const unitName=identity?.unitName ?? `hydra-${runId!.replace(/[^A-Za-z0-9_.-]/g,"-").slice(0,128)}`;
    try {
      const {stdout}=await execFileAsync("systemctl",["--user","show",unitName,"--property=LoadState","--property=ActiveState","--property=ControlGroup"],{encoding:"utf8",timeout:2000});
      const props=new Map(stdout.trim().split("\n").map(line=>line.split("=",2)) as [string,string][]);
      if(props.get("LoadState")==="not-found") return identity ? "dead" : "unknown";
      if(["active","activating","deactivating","reloading"].includes(props.get("ActiveState") ?? "")) return "alive";
      if(props.get("ActiveState")==="inactive" || props.get("ActiveState")==="failed") return "dead";
      return "unknown";
    } catch { return "unknown"; }
  }
  if(!identity || process.platform!=="linux") return "unknown";
  try {
    if(readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()!==identity.bootId) return "dead";
    let uncertain=false;
    for(const name of readdirSync("/proc").filter(name=>/^\d+$/.test(name))) {
      try {
        const stat=readFileSync(`/proc/${name}/stat`,"utf8");
        const fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
        if(fields[0]==="Z") continue;
        if(Number(fields[2])===identity.pid) return "alive";
        if(Number(name)===identity.pid && fields[19]===identity.startTicks) return "alive";
      } catch(error) { if(!["ENOENT","ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) uncertain=true; }
    }
    return uncertain ? "unknown" : "dead";
  } catch { return "unknown"; }
}

export async function terminateTrackedProcess(identity:ProcessIdentity):Promise<boolean> {
  if(identity.unitName) {
    try {await execFileAsync("systemctl",["--user","kill","--signal=SIGKILL","--kill-whom=all",identity.unitName],{timeout:2000});return true;} catch {return false;}
  }
  try {
    const current=processIdentity(identity.pid);
    if(current.startTicks!==identity.startTicks || current.bootId!==identity.bootId) return false;
    process.kill(-identity.pid,"SIGKILL");return true;
  } catch {return false;}
}
