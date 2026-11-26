// Browser-only fixture: every request, provider action and run is held in memory.
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AgentCommandCenter } from "../../../../features/agents/components/AgentCommandCenter";
import { DialogProvider } from "../../../../components/ui/Dialogs";
import { SidebarSlotProvider } from "../../../../components/layout/SidebarCollection";
import {
  setBrowserIdentity,
  userLocalStorage,
} from "../../../../lib/identityStorage";
import {
  PROVIDER_IDS,
  type ProviderId,
  type ProviderInfo,
  type ProviderUsage,
  type SettingField,
  type SettingsSnapshot,
} from "@hydra/shared";
import type { RunStatus } from "../../../../models/runs";

const groups = {
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor CLI",
  grok: "Grok CLI",
  copilot: "GitHub Copilot",
  kilocode: "Kilo Code",
};
const field = (
  key: string,
  group: string,
  label: string,
  value: SettingField["value"],
  extra: Partial<SettingField> = {},
): SettingField => ({
  key,
  group,
  label,
  value,
  defaultValue: value,
  type: "string",
  description: `${label} applies to new runs.`,
  envVar: `HYDRA_FIXTURE_${key}`,
  placeholder: null,
  options: null,
  overridden: false,
  isSet: false,
  danger: false,
  dangerWhenTrue: false,
  requiresRestart: false,
  scale: null,
  ...extra,
});
const efforts = ["", "low", "medium", "high"].map((value) => ({
  value,
  label: value ? value[0]?.toUpperCase() + value.slice(1) : "Inherit global",
  hint: null,
  danger: false,
}));
let snapshot: SettingsSnapshot = {
  storagePath: "fixture/settings.json",
  groups: [
    "Model access",
    "General",
    "Run budgets",
    "Resource containment",
    "Pipeline policy",
    "Retention",
    "Future scheduling",
    ...Object.values(groups),
  ],
  fields: [
    field("models.accessTier", "Model access", "Model access tier", "all"),
    field("models.selectionMode", "Model access", "Model choice", "manual"),
    field(
      "models.reasoningEffort",
      "Model access",
      "Reasoning effort",
      "medium",
    ),
    field("hostAccess", "General", "Host access (Docker)", false, {
      type: "boolean",
      dangerWhenTrue: true,
      description:
        "Removes provider sandboxes and allows Docker and host services.",
    }),
    field("budget.maxCalls", "Run budgets", "Tool calls", 120, {
      type: "number",
      overridden: true,
      defaultValue: 60,
    }),
    field(
      "containment.maxProcesses",
      "Resource containment",
      "Process limit",
      32,
      { type: "number" },
    ),
    field("pipeline.retries", "Pipeline policy", "Retries", 3, {
      type: "number",
    }),
    field("retention.days", "Retention", "Transcript days", 30, {
      type: "number",
    }),
    field("future.schedule", "Future scheduling", "Future schedule", "Nightly"),
    ...PROVIDER_IDS.flatMap((id) => [
      field(`${id}.enabled`, groups[id], "Enabled", true, { type: "boolean" }),
      field(`${id}.model`, groups[id], "Model", `${id}-frontier`, {
        overridden: true,
        defaultValue: "",
        description:
          "Saved provider fallback. Eligible browser choices take precedence in Manual; Auto Select ignores manual defaults.",
      }),
      field(`${id}.reasoningEffort`, groups[id], "Reasoning effort", "", {
        type: "select",
        options: efforts,
      }),
      field(`${id}.sandbox`, groups[id], "Sandbox", "workspace-write", {
        type: "select",
        options: [
          {
            value: "workspace-write",
            label: "Workspace",
            hint: "Writes confined to the workspace.",
            danger: false,
          },
          {
            value: "danger-full-access",
            label: "Full access",
            hint: "Removes the OS sandbox; commands can access the host.",
            danger: true,
          },
        ],
      }),
      field(`${id}.apiKey`, groups[id], "API key", "", {
        type: "password",
        isSet: true,
      }),
      field(`${id}.binary`, groups[id], "Binary", id),
      field(`${id}.args`, groups[id], "Extra arguments", ""),
    ]),
  ],
};
let connection = "open";
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (callback: () => void) => {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
};
const emit = () => {
  version++;
  for (const listener of listeners) listener();
};
const value = (key: string) =>
  snapshot.fields.find((entry) => entry.key === key)?.value;
const states: Partial<Record<ProviderId, string>> = {};
let failure: "save" | "reset" | "settings" | "usage" | "detect" | null = null;
let settingsDelay =
  new URLSearchParams(location.search).get("fixtureSettings") === "slow"
    ? 750
    : 0;
if (new URLSearchParams(location.search).get("fixtureSettings") === "failed")
  failure = "settings";
let mutationDelay = 0;
let usageDelay = 0;
const requests: { url: string; method: string; body: unknown }[] = [];
let usages: ProviderUsage[] = PROVIDER_IDS.map((id) => ({
  provider: id,
  available: true,
  reason: null,
  plan: "Fixture plan",
  fetchedAt: new Date().toISOString(),
  windows: [
    {
      kind: "session",
      usedPercent: 0,
      durationMinutes: 300,
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    {
      kind: "weekly",
      usedPercent: 72,
      durationMinutes: null,
      resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  ],
  credits: { balance: 0, used: 0, limit: 0, enabled: false, currency: "USD" },
}));

function providers(): ProviderInfo[] {
  return PROVIDER_IDS.map((id) => {
    const reasoningEffort = (value(`${id}.reasoningEffort`) ||
      value("models.reasoningEffort")) as ProviderInfo["reasoningEffort"];
    const restricted = value("models.accessTier") !== "all";
    const auto = value("models.selectionMode") === "auto";
    const model =
      id === "cursor"
        ? `cursor-${restricted ? "efficient" : "frontier"}-${reasoningEffort}`
        : `${id}-${restricted ? "efficient" : "frontier"}`;
    const enabled = value(`${id}.enabled`) === true;
    return {
      id,
      label: groups[id],
      available: enabled && states[id] !== "unavailable",
      reason: !enabled
        ? "Turned off in settings"
        : states[id] === "unavailable"
          ? "API key not configured or login unavailable"
          : null,
      version: "1.2.3-fixture",
      binary: `/fixture/bin/${id}`,
      reportsTokens: true,
      transport: id === "claude" ? "sdk" : "spawn",
      permissionMode: value("hostAccess")
        ? "danger-full-access"
        : String(value(`${id}.sandbox`)),
      configuredModel: String(value(`${id}.model`)) || null,
      model:
        auto || restricted || id === "cursor"
          ? model
          : String(value(`${id}.model`)) || null,
      modelAccessTier: value(
        "models.accessTier",
      ) as ProviderInfo["modelAccessTier"],
      modelSelectionMode: auto ? "auto" : "manual",
      reasoningEffort,
      tierDefaultModel: model,
      totalModels: 2,
      models: [
        { id: model, label: model, hint: "Fixture model" },
        ...(!restricted && id !== "cursor"
          ? [
              {
                id: `${id}-efficient`,
                label: `${id}-efficient`,
                hint: "Economical fixture",
              },
            ]
          : []),
      ],
      cooling: null,
    };
  });
}
const run = (id: ProviderId, role: RunStatus["role"]): RunStatus =>
  ({
    runId: `fixture-${id}-${role}`,
    provider: id,
    role,
    model: `${id}-actual-run`,
    startedAt: new Date().toISOString(),
    elapsedMs: 90000,
    permissionMode: "workspace-write",
    state: "running",
    detail: "Fixture activity",
    usage: {
      totalTokens: 12345,
      inputTokens: 10000,
      outputTokens: 2345,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    workspace: { id: 1, name: "Fixture workspace", workDirectory: "/fixture" },
    source: {
      type: "custom",
      title: "Fixture task",
      displayText: "Fixture task",
      threadId: "fixture-thread",
    },
    result: null,
    exitCode: null,
  }) as RunStatus;
const hydra = () => ({
  providers: providers(),
  runs: PROVIDER_IDS.filter((id) => states[id] === "busy").map((id) =>
    run(id, id === "claude" ? "consult" : "execute"),
  ),
  items: [],
  lastRun: null,
  connection,
  disconnectedRuns: [],
  inputRequests: {},
  pendingLaunches: [],
  runTabIds: {},
  answerInput: () => {},
  refreshProviders: async () => {
    emit();
  },
});
export function useFixtureHydra() {
  useSyncExternalStore(subscribe, () => version);
  return hydra();
}
export function useFixtureFleet() {
  const state = useFixtureHydra();
  return { ...state, stale: connection !== "open" };
}
export function useFixtureMetadata() {
  return {
    origins: {},
    queued: [],
    loading: false,
    error: null,
    refresh: () => {},
  };
}
export function useFixtureWorkspace() {
  return {
    workspaces: [{ id: 1, name: "Fixture workspace" }],
    workspaceId: 1,
    status: "loaded",
  };
}
export function useFixtureStop() {
  return {
    open: (input: unknown) => {
      requests.push({ url: "fixture-stop", method: "MOCK", body: input });
    },
  };
}

window.fetch = async (input, init) => {
  const url = new URL(String(input), window.location.origin);
  if (!url.pathname.startsWith("/api/"))
    throw new Error(`Fixture blocked network request: ${url}`);
  const method = init?.method ?? "GET";
  const body = init?.body
    ? (JSON.parse(String(init.body)) as Record<string, SettingField["value"]>)
    : null;
  requests.push({ url: url.pathname + url.search, method, body });
  if (url.pathname === "/api/settings" && method === "GET" && settingsDelay)
    await new Promise((resolve) => setTimeout(resolve, settingsDelay));
  if (url.pathname === "/api/providers/usage" && usageDelay)
    await new Promise((resolve) => setTimeout(resolve, usageDelay));
  if (method !== "GET" && mutationDelay)
    await new Promise((resolve) => setTimeout(resolve, mutationDelay));
  const fail = (path: string, kind: typeof failure) =>
    url.pathname === path && failure === kind;
  if (
    fail("/api/providers/usage", "usage") ||
    fail("/api/settings", "settings") ||
    (method === "PUT" && failure === "save") ||
    fail("/api/settings/reset", "reset") ||
    fail("/api/providers", "detect")
  ) {
    failure = null;
    return Response.json(
      { errors: ["Fixture validation or connection failure"] },
      { status: 503 },
    );
  }
  if (url.pathname === "/api/settings" && method === "PUT" && body) {
    const changed = Object.keys(body);
    snapshot = {
      ...snapshot,
      fields: snapshot.fields.map((entry) => {
        if (!(entry.key in body)) return entry;
        const next = body[entry.key];
        return entry.type === "password"
          ? { ...entry, value: "", isSet: next !== "", overridden: true }
          : { ...entry, value: next, overridden: next !== entry.defaultValue };
      }),
    };
    emit();
    return Response.json({ snapshot, changed });
  }
  if (url.pathname === "/api/settings/reset") {
    const keys = (body as unknown as { keys: string[] }).keys;
    snapshot = {
      ...snapshot,
      fields: snapshot.fields.map((entry) =>
        keys.includes(entry.key)
          ? { ...entry, value: entry.defaultValue, overridden: false }
          : entry,
      ),
    };
    emit();
    return Response.json({ snapshot, changed: keys });
  }
  if (url.pathname === "/api/settings") return Response.json(snapshot);
  if (url.pathname === "/api/providers/usage")
    return Response.json({ usage: usages });
  if (url.pathname.endsWith("/update"))
    return Response.json({ updated: true, before: "1.2.3", after: "1.2.4" });
  if (url.pathname === "/api/providers")
    return Response.json({ providers: providers() });
  throw new Error(`Unmocked fixture request: ${url.pathname}`);
};
const fixture = {
  requests,
  setConnection(next: string) {
    connection = next;
    emit();
  },
  setState(id: ProviderId, state: string) {
    states[id] = state;
    const enabled = snapshot.fields.find(
      (field) => field.key === `${id}.enabled`,
    );
    if (enabled) enabled.value = state !== "disabled";
    emit();
    window.dispatchEvent(
      new CustomEvent("hydra.settings-updated", {
        detail: structuredClone(snapshot),
      }),
    );
  },
  pin(id: ProviderId, model: string | null) {
    const choices = JSON.parse(
      userLocalStorage.getItem("hydra.models") ?? "{}",
    );
    choices[id] = model;
    userLocalStorage.setItem("hydra.models", JSON.stringify(choices));
    window.dispatchEvent(new Event("storage"));
  },
  fail(next: typeof failure) {
    failure = next;
  },
  delaySettings(ms: number) {
    settingsDelay = ms;
  },
  delayMutation(ms: number) {
    mutationDelay = ms;
  },
  delayUsage(ms: number) {
    usageDelay = ms;
  },
  setUsage(next: ProviderUsage[]) {
    usages = next;
  },
  snapshot() {
    return structuredClone(snapshot);
  },
  updateSetting(key: string, next: SettingField["value"]) {
    const entry = snapshot.fields.find((field) => field.key === key);
    if (entry) entry.value = next;
    emit();
    window.dispatchEvent(
      new CustomEvent("hydra.settings-updated", {
        detail: structuredClone(snapshot),
      }),
    );
  },
};
declare global {
  interface Window {
    hydraFixture: typeof fixture;
  }
}
window.hydraFixture = fixture;
setBrowserIdentity({
  id: "fixture",
  username: "fixture",
  ownsLegacyData: false,
});
function App() {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <DialogProvider>
      <SidebarSlotProvider value={{ target: slot, onNavigate() {} }}>
        <div
          style={{
            display: "flex",
            height: "100vh",
            color: "var(--fg)",
            background: "var(--surface-0)",
          }}
        >
          <aside
            id="fixture-sidebar"
            style={{
              width: 224,
              padding: "24px 12px",
              flexShrink: 0,
              borderRight: "1px solid var(--line)",
              overflow: "auto",
            }}
          >
            <strong>Hydra</strong>
            <p style={{ color: "var(--fg-muted)", margin: "16px 0" }}>Agents</p>
            <div ref={setSlot} />
          </aside>
          <main
            style={{
              display: "flex",
              flex: 1,
              minWidth: 0,
              flexDirection: "column",
            }}
          >
            <AgentCommandCenter />
          </main>
        </div>
      </SidebarSlotProvider>
    </DialogProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
