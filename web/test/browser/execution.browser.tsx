import {createRoot} from "react-dom/client";
import {useState} from "react";
import {ExecutionPanel} from "../../components/pipeline/ExecutionPanel";
import {RunConfidenceStrip} from "../../components/pipeline/RunConfidenceStrip";
import {PipelineStatusBar} from "../../components/pipeline/PipelineStatusBar";
import {pipelineStatus} from "../../components/pipeline/status";
import {DEFAULT_PIPELINE_POLICY,type ExecutionStatus,type OperationsPrompt} from "@agent-console/shared";
import {DialogProvider} from "../../components/ui/Dialogs";
import {ToastProvider} from "../../components/ui/Toast";
import {useStationActions} from "../../components/pipeline/station/useStationActions";
const policy={maxAttempts:6,maxActiveMs:18000000,maxTokens:1500000,deadline:Date.now()+86400000,workerMs:2700000,workerTokens:250000,unitAttempts:3,recoveryAttempts:2,maxReplans:2,maxProviderChanges:2};
let scenario="pending";
let approved=false;
let allocation:typeof policy|null=null;
const requests:unknown[]=[];
Object.assign(window,{executionRequests:requests,manualRunRequests:0,pipelineRunRequests:0});
const status=():ExecutionStatus=>({contractId:"fixture",engine:"supervised",desired:"RUNNING",phase:scenario==="delivered"?"delivered":"verification",revision:2,generation:4,acceptedUnits:scenario==="delivered"?[1,2]:[1],totalUnits:2,attempts:scenario==="exhausted"?(approved?7:6):4,activeMs:700000,tokens:320000,reservedMs:0,reservedTokens:0,policy:allocation??policy,lastDecision:scenario==="exhausted"?"execution_exception":"recovery_selected",lastRecovery:"diagnose",exception:scenario==="exhausted"&&!approved?{code:"budget_exhausted",reason:"Approved root envelope exhausted; checkpoint and remaining business verification are preserved"}:null,nextWakeAt:null,pendingObligations:scenario==="delivered"?[]:["business"]});
window.fetch=async(_url,init)=>{
  if(String(_url).endsWith('/api/pipelines/9/play')) {
    Object.assign(window,{pipelineRunRequests:1});
    return new Promise<Response>(resolve=>Object.assign(window,{resolvePipelineStart:()=>resolve(new Response(JSON.stringify({run:{state:"WAITING_HUMAN",waitReason:"execution:budget_exhausted",stopReason:null}}),{status:200,headers:{"Content-Type":"application/json"}}))}));
  }
  if(init?.method==="POST") {
    const request=JSON.parse(String(init.body));requests.push(request);
    if(request.reason==="Reject this allocation") return new Response(JSON.stringify({error:{code:"allocation_rejected",message:"Allocation was rejected; existing allowance is unchanged"}}),{status:422,headers:{"Content-Type":"application/json"}});
    approved=true;allocation=request.policy;
  }
  return new Response(JSON.stringify({execution:status(),plan:{revision:2,units:[{promptId:1,targets:["Access bindings"],phase:"implementation",criterionIds:["bindings"]},{promptId:2,targets:["Business scenarios"],phase:"verification",criterionIds:["business"]}]},events:[{sequence:1,kind:"recovery_selected",payload:{reason:"Changed strategy after failed ownership check"},createdAt:Date.now()}]}),{status:200,headers:{"Content-Type":"application/json"}});
};
function RunFixture(){
  const actions=useStationActions({pipelineId:9,pipelineState:"WAITING_HUMAN",refresh:async()=>{}});
  return <button disabled={actions.busy} onClick={()=>void actions.run({prompt:{id:1,externalKey:"S1-02"},pipelineRule:{provider:null}} as OperationsPrompt)}>Run S1-02</button>;
}
function Harness(){const [selected,setSelected]=useState(scenario);return <main style={{maxWidth:600,padding:16}}><nav>{["pending","delivered","exhausted"].map(item=><button key={item} onClick={()=>{scenario=item;setSelected(item);}}>{item}</button>)}</nav>{selected==="exhausted"&&<PipelineStatusBar status={pipelineStatus({run:{state:"WAITING_HUMAN",stopReason:null,waitReason:"execution:budget_exhausted"},stationState:"UNREPORTED",station:"S1-02",awaitingHuman:false})} position={null} blockedReason={null} recoveryActions={null} busy={false} onControl={()=>{}} onExplain={()=>{}}/>}<ExecutionPanel key={selected} promptId={1}/><RunConfidenceStrip execution={status()} policy={DEFAULT_PIPELINE_POLICY} suiteFallbacks={[]} stationFallbacks={[]} continuation={{attempt:3,of:3}} waitReason={selected==="exhausted"?"execution:budget_exhausted":null} occupancyWrapUp={false} latestAudit={null} onOpenTab={()=>{}}/><RunFixture/></main>;}
createRoot(document.getElementById("root")!).render(<ToastProvider><DialogProvider><Harness/></DialogProvider></ToastProvider>);
