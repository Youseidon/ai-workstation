import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { DodCriterion } from "@agent-console/shared";
import { executionHash } from "./executionStore.ts";

/** Broad by design: tracked and nonignored untracked inputs, not just HEAD. */
export function sourceFingerprint(directory: string): string {
  const root = realpathSync(directory);
  let paths: string[];
  try {
    paths = execFileSync("git",["-C",root,"ls-files","--cached","--others","--exclude-standard","-z"],{encoding:"utf8",maxBuffer:32*1024*1024,stdio:["ignore","pipe","ignore"]}).split("\0").filter(Boolean);
    // A subdirectory must include its repository's transitive inputs too.
    const top = execFileSync("git",["-C",root,"rev-parse","--show-toplevel"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();
    if(realpathSync(top)!==root) return sourceFingerprint(top);
  } catch {
    paths=[];
    const walk=(dir:string):void=>{
      for(const entry of readdirSync(dir,{withFileTypes:true})) {
        if([".git","node_modules",".next","bin","obj",".agent-console",".artifacts"].includes(entry.name)) continue;
        const path=join(dir,entry.name);
        if(entry.isDirectory()) walk(path); else paths.push(relative(root,path));
      }
    };
    walk(root);
  }
  for(const instruction of ["AGENTS.md","CLAUDE.md"]) if(existsSync(join(root,instruction)))paths.push(instruction);
  const hash=createHash("sha256");
  for(const name of [...new Set(paths)].sort()) {
    const path=resolve(root,name);
    if(!path.startsWith(`${root}/`)) throw new Error("Fingerprint path escapes repository");
    hash.update(name).update("\0");
    try {
      const stat=lstatSync(path);
      hash.update(String(stat.mode)).update("\0");
      if(stat.isSymbolicLink()) {
        const target=realpathSync(path);
        if(!target.startsWith(`${root}/`)) throw new Error("External symlink inputs cannot be verified without an explicit dependency closure");
        hash.update(readlinkSync(path));
        if(lstatSync(target).isFile()) hash.update(readFileSync(target));
        else throw new Error("Directory symlink dependency closure is unknown");
      }
      else if(stat.isFile()) hash.update(readFileSync(path));
      else if(stat.isDirectory()) throw new Error("Submodule input closure is unknown; verification cannot be reused");
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==="ENOENT") hash.update("deleted"); else throw error;
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Values stay hashed; secret environment contents never enter an artifact. */
export function environmentFingerprint(directory=process.cwd()): string {
  const installed:Record<string,string>={};
  let ancestor=realpathSync(directory);
  for(let depth=0;depth<8;depth++) {
    for(const file of ["node_modules/.package-lock.json","node_modules/typescript/package.json",".pnp.cjs"]) {
      const path=join(ancestor,file);if(existsSync(path))installed[path]=executionHash(readFileSync(path));
    }
    const parent=dirname(ancestor);if(parent===ancestor)break;ancestor=parent;
  }
  const binary=(process.env.PATH ?? "").split(":").map(path=>join(path,"dotnet")).find(path=>existsSync(path));
  let dotnet:unknown=null;
  if(binary) {
    const result=spawnSync(binary,["--info"],{cwd:directory,encoding:"utf8",timeout:5000,maxBuffer:512*1024,env:{...process.env,DOTNET_CLI_TELEMETRY_OPTOUT:"1",DOTNET_SKIP_FIRST_TIME_EXPERIENCE:"1"}});
    if(result.status!==0 || !result.stdout?.trim()) throw new Error("Cannot establish the effective .NET toolchain fingerprint");
    const stat=statSync(realpathSync(binary));dotnet={info:result.stdout,size:stat.size,modified:stat.mtimeMs};
  }
  // The Claude SDK sets this marker when query() starts. It describes the
  // provider transport, not the environment of a named verification command.
  return executionHash({platform:process.platform,arch:process.arch,versions:process.versions,installed,dotnet,env:Object.entries(process.env).filter(([key])=>!key.startsWith("AGENT_CONSOLE_")&&key!=="SETTINGS_FILE"&&key!=="CLAUDE_AGENT_SDK_VERSION").sort(([a],[b])=>a.localeCompare(b))});
}

export function recipeFingerprint(criterion:DodCriterion):string {
  return executionHash({id:criterion.id,command:criterion.command,cwd:criterion.cwd,expectExitCode:criterion.expectExitCode,timeoutMs:criterion.timeoutMs,kind:criterion.kind,text:criterion.text});
}

export function repositoryResource(directory:string):string {
  const root=realpathSync(directory);
  try {return `repository:${realpathSync(execFileSync("git",["-C",root,"rev-parse","--show-toplevel"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim())}`;}
  catch {return `repository:${root}`;}
}
