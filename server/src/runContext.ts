import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** `programId`: a consult about a whole program rather than one work item. */
interface Entry { runId:string; workspaceId:number; promptId:number|null; question:string; tokenHash:string; expiresAt:number; programId:number|null }
const entries=new Map<string,Entry>();
const ACTIVE_TTL_MS=12*60*60*1000;
const COMPLETED_TTL_MS=5*60*1000;

export function hashRunToken(token:string):string { return createHash("sha256").update(token).digest("hex"); }
function prune():void { const now=Date.now();for(const [runId,entry] of entries)if(entry.expiresAt<=now)entries.delete(runId); }

export const runContexts={
  create(runId:string,workspaceId:number,promptId:number|null,ttlMs=ACTIVE_TTL_MS,question="",programId:number|null=null):{token:string;tokenHash:string;expiresAt:string}{prune();const token=randomBytes(24).toString("base64url");const tokenHash=hashRunToken(token);const expiresAt=Date.now()+(ttlMs??ACTIVE_TTL_MS);entries.set(runId,{runId,workspaceId,promptId,question,tokenHash,expiresAt,programId});return{token,tokenHash,expiresAt:new Date(expiresAt).toISOString()};},
  authenticate(runId:string,token:string):Entry|null{prune();const entry=entries.get(runId);if(!entry)return null;const supplied=Buffer.from(hashRunToken(token),"hex");const expected=Buffer.from(entry.tokenHash,"hex");return supplied.length===expected.length&&timingSafeEqual(supplied,expected)?entry:null;},
  complete(runId:string):void{const entry=entries.get(runId);if(entry)entry.expiresAt=Date.now()+COMPLETED_TTL_MS;},
  revoke(runId:string):void{entries.delete(runId);},
};
