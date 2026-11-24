import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DEFAULT_PIPELINE_POLICY, defaultPromptPipelineRule, type PipelineFlowchartView, type PipelineRecord, type ProviderInfo } from "@agent-console/shared";
import { AgentAssignments } from "../../components/pipeline/AgentAssignments";

const providers = ["claude", "codex", "cursor"].map(id => ({ id, available: id !== "cursor", model: null, modelSelectionMode: "manual", models: [{ id: `${id}-model`, label: `${id} model` }] })) as ProviderInfo[];
const initial = { pipelineId: 1, suiteId: 10, defaults: { suiteId: 10, defaultProvider: null, defaultModel: null, defaultFallbackProviders: [] },
  steps: [1, 2].map(id => ({ ...defaultPromptPipelineRule(id), enabled: true })),
  subSteps: [{ promptId: 3, parentPromptId: 1, depth: 1, inherited: true, rule: defaultPromptPipelineRule(3) }], available: [], rules: [], active: null, latest: null } as PipelineFlowchartView;
function Harness() {
  const [view, setView] = useState(initial);
  const [autoReassign, setAuto] = useState(false);
  const [configured, setConfigured] = useState(0);
  return <div className="mx-auto max-w-5xl p-4"><AgentAssignments pipeline={{ id: 1, autoReassign } as PipelineRecord} suiteName="Implementation" view={view} providers={providers} policy={DEFAULT_PIPELINE_POLICY} busy={false}
    promptLabel={id => `P${id}`} onAutoReassign={setAuto} onConfigure={setConfigured}
    onDefaults={patch => setView(current => ({ ...current, defaults: { ...current.defaults, ...patch },
      steps: patch.resetPromptAgents ? current.steps.map(step => ({ ...step, provider: null, model: null })) : current.steps,
      subSteps: patch.resetPromptAgents ? current.subSteps.map(step => ({ ...step, inherited: true, rule: { ...step.rule, provider: null, model: null } })) : current.subSteps }))}
    onPrompt={(id, choice, inherit) => setView(current => ({ ...current,
      steps: current.steps.map(step => step.promptId === id ? { ...step, ...choice } : step),
      subSteps: current.subSteps.map(step => step.promptId === id ? { ...step, inherited: inherit, rule: { ...step.rule, ...choice } } : step) }))} />
    <output aria-label="Configured prompt">{configured}</output>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
