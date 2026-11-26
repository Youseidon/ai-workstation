"use client";
import { useEffect, useState } from "react";
import { validateExecutionPolicy, type ExecutionPolicy, type ExecutionStatus } from "@hydra/shared";
import { workspaceApi } from "@/api/workspacesApi";
import { SERVER_URL } from "@/api/serverUrl";
import { Modal } from "@/components/ui/Modal";

export function ExecutionAllocationDialog({promptId,onClose,onChanged}:{promptId:number|null;onClose():void;onChanged?():void}) {
  return <Modal open={promptId !== null} onClose={onClose} title="Approve more execution allowance" description="The previous allocation cannot run this work again. Review the proposed limits below, enter a reason, then choose Approve new allocation to continue from the saved work.">
    {promptId !== null && <ExecutionPanel key={promptId} promptId={promptId} onChanged={onChanged} reviewAllocation/>}
  </Modal>;
}

export function ExecutionPanel({promptId,onChanged,reviewAllocation=false}:{promptId:number;onChanged?():void;reviewAllocation?:boolean}) {
  const [data,setData]=useState<Awaited<ReturnType<typeof workspaceApi.execution>>|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [attempts,setAttempts]=useState(6);
  const [hours,setHours]=useState(5);
  const [tokens,setTokens]=useState(1500000);
  useEffect(()=>{let active=true;void workspaceApi.execution(SERVER_URL,promptId).then(result=>{if(active)setData(result);}).catch(error=>{if(active)setError(String(error));});return()=>{active=false;};},[promptId]);
  const action=async(action:string)=>{
    setBusy(true);setError("");
    try {
      const policy:ExecutionPolicy={maxAttempts:attempts,maxActiveMs:hours*3600000,maxTokens:tokens,deadline:Date.now()+24*3600000,workerMs:45*60000,workerTokens:250000,unitAttempts:3,recoveryAttempts:2,maxReplans:2,maxProviderChanges:2};
      await workspaceApi.executionAction(SERVER_URL,promptId,{action,...(action==="adopt"?{policy}: {})});
      setData(await workspaceApi.execution(SERVER_URL,promptId));
      onChanged?.();
    } catch(error) {setError(error instanceof Error?error.message:String(error));} finally {setBusy(false);}
  };
  const status=data?.execution;
  return <section aria-label="Autonomous execution" className="space-y-3 rounded-md border border-line p-3 text-xs text-fg-muted">
    <h3 className="font-semibold text-fg">Autonomous execution</h3>
    {error && <p role="alert" className="text-caution">{error}</p>}
    {!data ? <p>Loading execution contract…</p> : !status ? <>
      <p>Capture this requirement and its required done criteria with a finite allowance. Shadow mode records proposed decisions. Enabling the supervisor takes effect at the next safe Play.</p>
      <div className="grid gap-2">
        <label>Total attempts <input aria-label="Total attempts" className="ml-2 w-24 rounded bg-surface-2 p-1" type="number" min="3" value={attempts} onChange={e=>setAttempts(Number(e.target.value))}/></label>
        <label>Active hours <input aria-label="Active hours" className="ml-2 w-24 rounded bg-surface-2 p-1" type="number" min="1" value={hours} onChange={e=>setHours(Number(e.target.value))}/></label>
        <label>Token allowance <input aria-label="Token allowance" className="ml-2 w-28 rounded bg-surface-2 p-1" type="number" min="250000" value={tokens} onChange={e=>setTokens(Number(e.target.value))}/></label>
      </div>
      <p>Delivery deadline: 24 hours. Workers: 45 minutes, 250,000 reported tokens; three local attempts, two recovery attempts. Unknown usage consumes its full reservation.</p>
      <button disabled={busy} onClick={()=>void action("adopt")} className="rounded bg-surface-2 px-2 py-1 text-accent disabled:opacity-50">Capture in shadow mode</button>
    </> : <>
      {status.exception && <p role="status" className="text-caution">{status.exception.reason}</p>}
      {status.lastRecovery && <p>Recovery · {status.lastRecovery.replaceAll("_"," ")}</p>}
      {status.nextWakeAt && <p>Automatic provider retry at {new Date(status.nextWakeAt).toLocaleTimeString()}</p>}
      <p>{status.engine === "shadow" ? "Shadow mode" : status.exception ? "Exception" : status.desired.toLowerCase()} · {status.phase === "delivered" ? "Verified delivery" : status.phase === "verification" ? "Verification pending" : "Implementation in progress"}</p>
      <p>{status.acceptedUnits.length}/{data.plan?.units.length ?? 0} units accepted · {status.attempts}/{status.policy.maxAttempts} attempts accounted</p>
      <p>{Math.round(status.activeMs/60000)}/{Math.round(status.policy.maxActiveMs/60000)} active minutes · {status.tokens.toLocaleString()}/{status.policy.maxTokens.toLocaleString()} tokens accounted, including reservations</p>
      <p>Worker attempts per unit: {status.policy.unitAttempts} · Recovery attempts: {status.policy.recoveryAttempts} · Deadline: {new Date(status.policy.deadline).toLocaleString()}</p>
      {status.pendingObligations.length>0 && <p>Deferred verification: {status.pendingObligations.join(", ")}</p>}
      <p>Last decision: {status.lastDecision?.replaceAll("_"," ") ?? "none"}</p>
      {status.engine === "shadow" && <button disabled={busy} onClick={()=>void action("enable")} className="rounded bg-surface-2 px-2 py-1 text-accent disabled:opacity-50">Enable supervisor for next Play</button>}
      {status.engine === "supervised" && status.phase !== "delivered" && <AllocationForm key={status.contractId} status={status} promptId={promptId} initiallyOpen={reviewAllocation} onSaved={async()=>{setData(await workspaceApi.execution(SERVER_URL,promptId));onChanged?.();}}/>}
      <details><summary>Plan and decision history</summary>
        <ol className="mt-2 space-y-2">{data.plan?.units.map(unit=><li key={unit.promptId}>{unit.targets.join(", ")} · {unit.phase} · {unit.criterionIds.join(", ")}</li>)}</ol>
        <ol className="mt-3 space-y-1">{data.events.slice(-20).map(event=><li key={event.sequence}>{new Date(event.createdAt).toLocaleTimeString()} · {event.kind.replaceAll("_"," ")}{event.payload && typeof event.payload==="object" && "reason" in event.payload ? ` · ${String(event.payload.reason)}` : ""}</li>)}</ol>
      </details>
    </>}
  </section>;
}

/** Every limit is cumulative: approving more work never clears usage or remedies. */
function AllocationForm({status,promptId,onSaved,initiallyOpen=false}:{status:ExecutionStatus;promptId:number;onSaved():Promise<void>;initiallyOpen?:boolean}) {
  const [open,setOpen]=useState(initiallyOpen || status.exception?.code === "budget_exhausted");
  const [policy,setPolicy]=useState<ExecutionPolicy>(()=>({...status.policy,
    maxAttempts:Math.max(status.policy.maxAttempts,status.attempts)+6,
    maxActiveMs:Math.max(status.policy.maxActiveMs,status.activeMs)+5*3600000,
    maxTokens:Math.max(status.policy.maxTokens,status.tokens)+1500000,
    unitAttempts:Math.max(status.policy.unitAttempts,status.attempts)+3,
    recoveryAttempts:status.policy.recoveryAttempts+2,
  }));
  const [deadlineHours,setDeadlineHours]=useState(24);
  const [reason,setReason]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [saved,setSaved]=useState(false);
  const fields:Array<{key:keyof ExecutionPolicy;label:string;scale?:number;step?:number}>=[
    {key:"maxAttempts",label:"Total attempts"},
    {key:"maxActiveMs",label:"Total active hours",scale:3600000,step:0.25},
    {key:"maxTokens",label:"Total token allowance"},
    {key:"unitAttempts",label:"Total worker attempts per unit"},
    {key:"recoveryAttempts",label:"Total recovery attempts"},
    {key:"workerMs",label:"Minutes per worker",scale:60000},
    {key:"workerTokens",label:"Tokens per worker"},
  ];
  return <div className="space-y-2 border-t border-line pt-2">
    <button type="button" className="text-accent" aria-expanded={open} onClick={()=>setOpen(!open)}>Review new allocation</button>
    {saved && <p role="status">Allocation approved. {status.desired === "RUNNING" ? "The pipeline has re-evaluated its waiting work." : "Use Run when ready to continue."}</p>}
    {open && <form className="space-y-3" onSubmit={async event=>{
      event.preventDefault();setBusy(true);setError("");setSaved(false);
      try {
        const allocation={...policy,deadline:Date.now()+deadlineHours*3600000};
        validateExecutionPolicy(allocation);
        if(!reason.trim()) throw new Error("Explain why you are approving more work.");
        const result=await workspaceApi.executionAction(SERVER_URL,promptId,{action:"budget",policy:allocation,reason:reason.trim()});
        await onSaved();
        if(result.execution.exception) setError(`Allocation recorded. ${result.execution.exception.reason}`);
        else {setOpen(false);setSaved(true);}
      } catch(error) {setError(error instanceof Error?error.message:String(error));} finally {setBusy(false);}
    }}>
      <p>Proposed cumulative limits for this requirement and its sub-steps. Recorded usage, accepted work and recovery history are preserved. Increasing only total attempts cannot renew an exhausted per-unit allowance.</p>
      <div className="grid gap-2">
        {fields.map(({key,label,scale=1,step=1})=><label key={key} className="flex flex-wrap items-center justify-between gap-2">{label}<input aria-label={label} className="w-32 rounded bg-surface-2 p-1" type="number" required min={key==="recoveryAttempts"?0:step} step={step} value={policy[key]/scale} onChange={event=>setPolicy({...policy,[key]:Math.round(Number(event.target.value)*scale)})}/></label>)}
        <label className="flex flex-wrap items-center justify-between gap-2">Deadline hours from approval<input aria-label="Deadline hours from approval" className="w-32 rounded bg-surface-2 p-1" type="number" required min="1" value={deadlineHours} onChange={event=>setDeadlineHours(Number(event.target.value))}/></label>
        <label>Reason for additional allocation<textarea aria-label="Reason for additional allocation" required className="mt-1 w-full rounded bg-surface-2 p-2" value={reason} onChange={event=>setReason(event.target.value)}/></label>
      </div>
      <p>{status.desired === "RUNNING" ? "Approval automatically retries work waiting for an allocation." : "Approval saves these limits. Use Run to continue."} Workers keep the displayed limits; replan and provider-change limits stay at {status.policy.maxReplans} and {status.policy.maxProviderChanges}.</p>
      {error && <p role="alert" className="text-caution">{error}</p>}
      <button type="submit" disabled={busy} className="rounded bg-surface-2 px-2 py-1 text-accent disabled:opacity-50">{busy ? "Approving…" : "Approve new allocation"}</button>
    </form>}
  </div>;
}
