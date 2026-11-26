"use client";

import { useEffect, useState } from "react";
import type { DemoAvailability } from "@hydra/shared";
import { demoApi } from "@/api/accountApi";
import { HydraMark } from "@/components/brand/HydraMark";
import { startDemoSession, type DemoSession } from "../lib/demoSession";
import { DemoLaunch } from "./DemoLaunch";
import styles from "./demo.module.css";

/**
 * "Try the demo" on the sign-in card. `onLaunching` lets the identity gate
 * stop its session polling: the demo cookie arrives while the launch is
 * still animating, and a refresh would otherwise reload the page mid-way.
 */
export function DemoEntry({ disabled, onLaunching, onEnter }: { disabled?: boolean; onLaunching(active: boolean): void; onEnter(): void }) {
  const [availability, setAvailability] = useState<DemoAvailability | null>(null);
  const [session, setSession] = useState<DemoSession | null>(null);
  useEffect(() => { void demoApi.availability().then(setAvailability).catch(() => setAvailability(null)); }, []);

  const launch = () => {
    onLaunching(true);
    setSession(startDemoSession(() => demoApi.start(), { reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches }));
  };

  if (!availability?.available) return null;
  return <>
    <p className={styles.divider} aria-hidden>or</p>
    <button type="button" className={styles.entry} disabled={disabled} onClick={launch}>
      <HydraMark size={34} tone="spectrum" />
      <span className={styles.entryText}>
        <span className={styles.entryTitle}>Try the demo</span>
        <span className={styles.entryHint}>A private sandbox with a real project, chats, pipelines and history. No sign-up; gone after {availability.lifetimeHours === 1 ? "an hour" : `${availability.lifetimeHours} hours`}.</span>
      </span>
      <span className={styles.entryGo} aria-hidden>→</span>
    </button>
    {session && <DemoLaunch session={session}
      onEnter={onEnter}
      onRetry={launch}
      onCancel={() => { setSession(null); void demoApi.abandon().finally(() => onLaunching(false)); }} />}
  </>;
}
