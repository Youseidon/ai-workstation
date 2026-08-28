"use client";

import { useEffect, useMemo, useState } from "react";
import type { PromptOption, ProviderId, WorkspaceRecord } from "@agent-console/shared";
import { AppNav } from "@/components/AppNav";
import { LogPanel } from "@/components/LogPanel";
import { PromptInput } from "@/components/PromptInput";
import { ProviderSwitcher } from "@/components/ProviderSwitcher";
import { SettingsPanel } from "@/components/SettingsPanel";
import { StatusBar } from "@/components/StatusBar";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { useModelSelection } from "@/lib/useModelSelection";
import { workspaceApi } from "@/lib/workspacesApi";

const SERVER_URL = process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? "http://127.0.0.1:4000";

export default function Page() {
  const console_ = useAgentConsole(SERVER_URL);
  const { providers, run, connection, items, workdir, lastRun } = console_;
  const [preferred, setPreferred] = useState<ProviderId | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [promptOptions, setPromptOptions] = useState<PromptOption[]>([]);
  const [savedPromptId, setSavedPromptId] = useState<number | null>(null);

  useEffect(() => { void workspaceApi.list(SERVER_URL).then((list) => {
    setWorkspaces(list);
    const remembered = Number(localStorage.getItem("agent-console.workspace"));
    setWorkspaceId(list.some((w) => w.id === remembered) ? remembered : list[0]?.id ?? null);
  }); }, []);
  useEffect(() => { if (workspaceId === null) return; localStorage.setItem("agent-console.workspace", String(workspaceId)); void workspaceApi.prompts(SERVER_URL, workspaceId).then(setPromptOptions); }, [workspaceId]);
  const activeWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const savedPrompt = promptOptions.find((p) => p.id === savedPromptId) ?? null;

  // Derived, not stored: honour the user's pick while it is usable, otherwise
  // fall back to the first available provider until they choose again.
  const selected = useMemo<ProviderId>(() => {
    const picked = providers.find((provider) => provider.id === preferred);
    if (picked?.available === true) return picked.id;
    return providers.find((provider) => provider.available)?.id ?? preferred ?? "claude";
  }, [providers, preferred]);

  const selectedInfo = useMemo(
    () => providers.find((provider) => provider.id === selected),
    [providers, selected],
  );

  const models = useModelSelection(providers);

  const running = run !== null;
  const canSend = connection === "open" && !running && selectedInfo?.available === true;

  return (
    <main className="flex h-dvh flex-col bg-[#0b0d10]">
      <header className="flex flex-wrap items-center gap-3 border-b border-[#1d2229] bg-[#0e1115] px-4 py-2.5">
        <h1 className="text-xs uppercase tracking-[0.2em] text-[#7d8794]">agent console</h1>
        <AppNav active="console" />
        <ProviderSwitcher
          providers={providers}
          selected={selected}
          disabled={running}
          models={models}
          onSelect={setPreferred}
          onRefresh={() => void console_.refreshProviders()}
        />
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={console_.clearLog}
            disabled={items.length === 0}
            className="rounded border border-[#1d2229] px-2.5 py-1.5 text-xs text-[#7d8794] transition-colors hover:text-[#d7dde5] disabled:opacity-40"
          >
            clear log
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="Configure providers, permissions and the working directory"
            className="rounded border border-[#1d2229] px-2.5 py-1.5 text-xs text-[#7d8794] transition-colors hover:text-[#d7dde5]"
          >
            ⚙ settings
          </button>
        </div>
      </header>

      <LogPanel items={items} workdir={activeWorkspace?.workDirectory ?? workdir} />

      <StatusBar
        connection={connection}
        provider={selectedInfo}
        model={models.resolve(selected)}
        run={run}
        lastRun={lastRun}
        workdir={activeWorkspace?.workDirectory ?? workdir}
      />

      <div className="flex flex-wrap items-center gap-2 border-t border-[#1d2229] bg-[#0e1115] px-4 py-2 text-xs">
        <span className="text-[#68727f]">Workspace</span>
        <select value={workspaceId ?? ""} disabled={running} onChange={(e)=>{setSavedPromptId(null);setPromptOptions([]);setWorkspaceId(Number(e.target.value));}} className="rounded border border-[#252c35] bg-[#101317] px-2 py-1.5 text-[#d7dde5]">
          {workspaces.length===0&&<option value="">No workspaces</option>}{workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <span className="ml-2 text-[#68727f]">Prompt</span>
        <select value={savedPromptId ?? "custom"} disabled={running||workspaceId===null} onChange={(e)=>setSavedPromptId(e.target.value==="custom"?null:Number(e.target.value))} className="min-w-52 rounded border border-[#252c35] bg-[#101317] px-2 py-1.5 text-[#d7dde5]">
          <option value="custom">Custom prompt</option>
          {promptOptions.map(p=><option key={p.id} value={p.id}>{p.programName} / {p.suiteName} / {p.title}</option>)}
        </select>
      </div>

      <PromptInput
        disabled={!canSend || workspaceId === null || !activeWorkspace?.workDirectoryExists}
        running={running}
        providers={providers}
        models={models}
        selected={selected}
        lockedPrompt={savedPrompt}
        onSubmit={(prompt) => workspaceId !== null && console_.startRun(workspaceId, selected, savedPrompt ? { promptId: savedPrompt.id } : { prompt }, models.resolve(selected))}
        onInterrupt={console_.interrupt}
        onTarget={(provider, model) => {
          setPreferred(provider);
          // A bare `@grok` picks the provider at the model it was already going
          // to use — that should not turn an inherited setting into a pin.
          if (model !== models.resolve(provider)) models.select(provider, model);
        }}
      />

      {settingsOpen && (
        <SettingsPanel
          serverUrl={SERVER_URL}
          onClose={() => setSettingsOpen(false)}
          runInProgress={running}
        />
      )}
    </main>
  );
}
