import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { ConversationPanel } from "../../components/chat/ConversationPanel";
import { Composer } from "../../components/Composer";
import { appendPrompt, applyEvent, type LogItem } from "../../lib/log";
import type { NormalizedEvent, ProviderId } from "@agent-console/shared";
import type { LiveConversationRun } from "../../lib/conversation";

const sample = "# Answer\n\n**Bold** and *emphasis*, [unsafe](javascript:alert(1)), [safe](https://example.com).\n\n- Parent\n  - Nested\n- [x] Done\n\n> Quoted\n\n| Field | Value |\n| --- | --- |\n| path | `src/a.ts` |\n\n```bash\nprintf \"%s\\n\" \"$HOME\" # literal * - ()\n```\n\n<script>window.compromised=true</script>";
const base = { provider: "codex" as const, model: "recorded", runId: "run", timestamp: "2026-11-16T00:00:00Z" };
function Harness() {
  const [items, setItems] = useState<LogItem[]>([
    {...base,id:"prompt",kind:"prompt",text:"Explain the repository"},
    {...base,id:"answer",kind:"text",blockId:"answer",textKind:"message",text:sample},
    {...base,id:"tool",kind:"tool",toolUseId:"tool",name:"bash",summary:"pwd",input:{command:"pwd"},result:{isError:false,summary:"ok",output:"/tmp",exitCode:0}},
    {...base,id:"done",kind:"result",state:"done",elapsedMs:1000,usage:null},
  ]);
  const [pending,setPending] = useState(false);
  const [failure,setFailure] = useState<string|null>(null);
  const [quote,setQuote] = useState("");
  const [sent,setSent] = useState("");
  const [accept,setAccept] = useState(false);
  const [busy,setBusy] = useState(false);
  const [blocked,setBlocked] = useState(false);
  const [lastAction,setLastAction] = useState("");
  const [liveRuns,setLiveRuns] = useState<LiveConversationRun[]>([]);
  const [disconnected,setDisconnected] = useState(false);
  const [liveProvider,setLiveProvider] = useState<ProviderId>("codex");
  const sequence = useRef(0);
  const liveEvent = (type: string, payload: unknown) => {
    const event = { ...base, provider: liveProvider, runId: "live", id: `live-${sequence.current++}`, type, payload } as NormalizedEvent;
    setItems(current => applyEvent(current, event));
  };
  const fixture = (action: string) => {
    if (action === "start") {
      setItems(current => appendPrompt(current, { ...base, provider: liveProvider, runId: "live", text: "Compare the streaming experience with the original layout" }));
      setLiveRuns([{ runId: "live", state: "starting" }]);
    } else if (action === "context") {
      liveEvent("status", { state: "running", conversation: { permissionKey: "read-only", context: "Earlier exchanges" } });
      setLiveRuns([{ runId: "live", state: "running" }]);
    } else if (action === "thinking") liveEvent("assistant_text", { blockId: "reasoning", delta: true, text: "Checking the recorded context", kind: "thinking" });
    else if (action === "tool") liveEvent("tool_use", { toolUseId: "read", name: "read_file", summary: "Read chat components", input: { path: "ConversationPanel.tsx" } });
    else if (action === "word1") {
      liveEvent("tool_result", { toolUseId: "read", name: "read_file", isError: false, summary: "Read", output: "Component source", exitCode: 0 });
      liveEvent("assistant_text", { blockId: "reply", delta: true, text: "Live words", kind: "message" });
    } else if (action === "word2") liveEvent("assistant_text", { blockId: "reply", delta: true, text: " arrive before completion.", kind: "message" });
    else if (action === "done") {
      liveEvent("result", { state: "done", text: "Live words arrive before completion.", elapsedMs:2000, usage:null, exitCode:0 });
      setLiveRuns([]);
    } else if (action === "disconnect") { setLiveRuns([]); setDisconnected(true); }
    else if (action === "long") {
      setItems(current => [...appendPrompt(current, { ...base, runId: "long", text: "A detailed prompt. ".repeat(50) }),
        { ...base, runId: "long", id: "long-answer", kind: "text", blockId: "long-answer", textKind: "message", text: "This answer belongs to the detailed prompt." },
        { ...base, runId: "long", id: "long-done", kind: "result", state: "done", elapsedMs:100, usage:null }]);
    }
  };
  const launch = (value: string, mode: "run" | "ask") => {
    setLastAction(mode);
    setSent(value); setPending(true); setFailure(null);
    setTimeout(() => { setFailure(accept ? null : "Launch failed"); setPending(false); }, 250);
  };
  const composer = <Composer disabled={false} running={busy} busy={busy} writer={null} providers={[]} models={{resolve:()=>null} as never} selected="codex"
    runBlockedReason={blocked ? "Run unavailable" : busy ? "Writer active" : null} askBlockedReason={busy ? "Tab busy" : null}
    savedPrompt={null} workdir="/tmp" context="Workspace" onTarget={()=>{}} onClearSavedPrompt={()=>{}} onInterrupt={()=>setBusy(false)}
    onSubmit={value=>launch(value,"run")} onAsk={value=>launch(value,"ask")}
    onQueue={(value,mode,stop)=>{setLastAction(`${stop ? "stop" : "queue"}-${mode}`);setSent(value);}}
    quote={quote} onClearQuote={()=>setQuote("")} launchPending={pending} launchFailed={failure} draftKey="browser" />;
  return <div style={{fontFamily:"Arial, sans-serif",height:"100vh",display:"flex",flexDirection:"column",minWidth:0}}>
    <button onClick={()=>setAccept(!accept)}>Launch outcome: {accept ? "accept" : "fail"}</button>
    <button onClick={()=>setItems(current=>[...current,{...base,id:`more-${current.length}`,kind:"text",blockId:`more-${current.length}`,textKind:"message",text:"New streamed reply. ".repeat(50)}])}>Stream update</button>
    <button onClick={()=>setBusy(!busy)}>Busy: {busy ? "yes" : "no"}</button>
    <button onClick={()=>setBlocked(!blocked)}>Run blocked: {blocked ? "yes" : "no"}</button>
    <select aria-label="Live fixture" value="" onChange={event=>fixture(event.target.value)}><option value="">Live fixture</option>{["start","context","thinking","tool","word1","word2","done","disconnect","long"].map(action=><option key={action} value={action}>{action}</option>)}</select>
    <select aria-label="Live provider" value={liveProvider} onChange={event=>setLiveProvider(event.target.value as ProviderId)}>{["claude","codex","cursor","copilot","grok","kilocode"].map(provider=><option key={provider} value={provider}>{provider}</option>)}</select>
    <div data-testid="last-action">{lastAction}</div>
    <ConversationPanel items={items} storageKey="browser" workdir="/tmp" liveRuns={liveRuns} disconnected={disconnected}
      pendingTurn={pending ? { id: "pending-browser", prompt: sent, provider: "codex", model: "recorded" } : undefined}
      onQuote={setQuote} footer={composer} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);
