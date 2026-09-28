"use client";

import { useCallback, useEffect, useState } from "react";
import type { SettingValue, SettingsSnapshot } from "@agent-console/shared";
import { useAgentConsole } from "./agentConsole";

interface Outcome {
  ok: boolean;
  errors: string[];
  changed: string[];
  snapshot: SettingsSnapshot | null;
}

interface ResponseBody {
  errors?: string[];
  changed?: string[];
  snapshot?: SettingsSnapshot;
}

/* Pure request helpers: no React state, so they are safe to call from an effect. */

async function getSnapshot(serverUrl: string): Promise<Outcome> {
  try {
    const response = await fetch(new URL("/api/settings", serverUrl), { cache: "no-store" });
    if (!response.ok) throw new Error(`settings request failed (${response.status})`);
    return { ok: true, errors: [], changed: [], snapshot: (await response.json()) as SettingsSnapshot };
  } catch (error) {
    return { ok: false, errors: [describe(error)], changed: [], snapshot: null };
  }
}

async function postJson(url: URL, method: string, body: unknown): Promise<Outcome> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as ResponseBody;
    if (!response.ok) {
      return {
        ok: false,
        errors: parsed.errors ?? [`request failed (${response.status})`],
        changed: [],
        snapshot: parsed.snapshot ?? null,
      };
    }
    return {
      ok: true,
      errors: [],
      changed: parsed.changed ?? [],
      snapshot: parsed.snapshot ?? null,
    };
  } catch (error) {
    return { ok: false, errors: [describe(error)], changed: [], snapshot: null };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Talks to the server's settings endpoints. The Agents page is rendered from
 * the snapshot's field descriptors, so a new server-side setting shows up in
 * the UI without any frontend change.
 */
export function useSettings(serverUrl: string) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const apply = useCallback((outcome: Outcome) => {
    if (outcome.snapshot !== null) setSnapshot(outcome.snapshot);
    setErrors(outcome.ok ? [] : outcome.errors);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getSnapshot(serverUrl).then((outcome) => {
      if (!cancelled) apply(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, apply]);

  /*
   * L-16. Without this the snapshot was read once on mount and after this page's
   * own save, so a change made anywhere else - another tab, the API, a script -
   * never arrived. Turning Team off by `PUT /api/settings` left `Team status`,
   * `Join team` and the create panel on screen until the page was reloaded, and
   * the Team thread panel's button still looked enabled. The API gate held, so
   * the stale button could not act; it could only mislead.
   *
   * The broadcast carries the whole snapshot, so this prefers it rather than
   * re-fetching: one message, no round trip, and every gated surface re-renders.
   *
   * **Derived, not mirrored.** Copying it into state inside an effect is what
   * `setState` in an effect means, and eslint is right to refuse it - it costs a
   * cascading render for no gain. Preferring it here is also *correct* rather than
   * merely cheaper, and only because every settings mutation broadcasts: both
   * `PUT`/`POST` and the reset route call `broadcastSettingsChange`
   * (server/src/index.ts:370 and :396), so once one has arrived it is never staler
   * than the copy fetched on mount. Before the first one it is null and the
   * fetched copy wins.
   */
  const broadcast = useAgentConsole().settings;

  const reload = useCallback(async () => {
    apply(await getSnapshot(serverUrl));
  }, [serverUrl, apply]);

  const save = useCallback(
    async (patch: Record<string, SettingValue>): Promise<Outcome> => {
      setSaving(true);
      const outcome = await postJson(new URL("/api/settings", serverUrl), "PUT", patch);
      apply(outcome);
      setSaving(false);
      return outcome;
    },
    [serverUrl, apply],
  );

  const reset = useCallback(
    async (keys?: string[]): Promise<Outcome> => {
      setSaving(true);
      const outcome = await postJson(
        new URL("/api/settings/reset", serverUrl),
        "POST",
        keys === undefined ? {} : { keys },
      );
      apply(outcome);
      setSaving(false);
      return outcome;
    },
    [serverUrl, apply],
  );

  // The broadcast wins once one has arrived; see the note above the read of it.
  const current = broadcast ?? snapshot;
  return {
    snapshot: current,
    loading: current === null && errors.length === 0,
    saving,
    errors,
    reload,
    save,
    reset,
  };
}
