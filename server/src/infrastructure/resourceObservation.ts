import { readFileSync } from "node:fs";
import { join } from "node:path";
export interface ResourceObservation {
  at:number;cpuTicks:number|null;rssBytes:number|null;reclaimEvents:number|null;
  ioBytes:number|null;outputVersion:string;advancement:boolean;pressureStalled:boolean;
}
function counters(path:string):Map<string,number> {
  return new Map(readFileSync(path,"utf8").trim().split("\n").map(line=>{const [key,value]=line.split(/\s+/);return [key!,Number(value)] as const;}));
}
export function observeResources(pid:number,outputVersion:string,previous:ResourceObservation|null,now=Date.now(),stallMs=120000,ownedCgroup?:string):ResourceObservation {
  let cpuTicks:number|null=null,rssBytes:number|null=null,reclaimEvents:number|null=null,ioBytes:number|null=null;
  try {
    const stat=readFileSync(`/proc/${pid}/stat`,"utf8");const fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
    cpuTicks=Number(fields[11])+Number(fields[12]);rssBytes=Number(fields[21])*4096;
    const io=counters(`/proc/${pid}/io`);ioBytes=(io.get("read_bytes:")??0)+(io.get("write_bytes:")??0);
    const cgroup=ownedCgroup;
    if(cgroup) {
      const events=counters(join("/sys/fs/cgroup",cgroup,"memory.events"));
      reclaimEvents=events.get("high")??0;
      rssBytes=Number(readFileSync(join("/sys/fs/cgroup",cgroup,"memory.current"),"utf8").trim());
      const cpu=counters(join("/sys/fs/cgroup",cgroup,"cpu.stat"));cpuTicks=(cpu.get("usage_usec")??0)/10000;
      const io=readFileSync(join("/sys/fs/cgroup",cgroup,"io.stat"),"utf8");ioBytes=[...io.matchAll(/\b(?:rbytes|wbytes)=(\d+)/g)].reduce((total,match)=>total+Number(match[1]),0);
    }
  } catch {  }
  const advancement=!!previous && (previous.outputVersion!==outputVersion || (ioBytes!==null && previous.ioBytes!==null && ioBytes>previous.ioBytes));
  return {at:now,cpuTicks,rssBytes,reclaimEvents,ioBytes,outputVersion,advancement,pressureStalled:!!previous && !advancement && reclaimEvents!==null && previous.reclaimEvents!==null && reclaimEvents>previous.reclaimEvents && now-previous.at>=stallMs};
}
