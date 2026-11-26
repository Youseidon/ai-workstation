"use client";

import { useEffect, useMemo, useReducer, useRef, type CSSProperties } from "react";
import { HydraMark } from "@/components/brand/HydraMark";
import { CountUp } from "@/components/ui/CountUp";
import { DEMO_FILES, DEMO_MANIFEST, DEMO_STAGES, INITIAL_LAUNCH, READY_TITLE, TOUR_AUTOSTART_KEY, launchReducer, litHeads, stageIndex } from "../lib/demoLaunch";
import type { DemoSession } from "../lib/demoSession";
import styles from "./demo.module.css";

/**
 * The "Try the demo" sequence. The server creates the account and streams
 * what it is preparing; this screen replays those real events at a readable
 * pace: each stage wakes part of the mark, the log prints the real folder and
 * account name, and the manifest counts what the visitor is about to get.
 */
export function DemoLaunch({ session, onEnter, onCancel, onRetry }: { session: DemoSession; onEnter(tour: boolean): void; onCancel(): void; onRetry(): void }) {
  const [state, dispatch] = useReducer(launchReducer, INITIAL_LAUNCH);
  const { current, completed, log, username, folder, error, ready } = state;
  const logRef = useRef<HTMLOListElement>(null);
  const enterRef = useRef<HTMLButtonElement>(null);
  useEffect(() => session.subscribe(dispatch), [session]);
  useEffect(() => { logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" }); }, [log]);
  useEffect(() => { if (ready) enterRef.current?.focus(); }, [ready]);

  const live = useMemo(() => litHeads(completed), [completed]);
  const index = stageIndex(current);
  const progress = ready ? 1 : Math.min(1, (completed.size) / DEMO_STAGES.length);
  const stage = DEMO_STAGES[index];
  const title = error ? "The demo hit a snag" : ready ? READY_TITLE : stage?.title ?? "Preparing";
  const filesShown = completed.has("folder") ? DEMO_FILES.length : current === "folder" ? Math.ceil(DEMO_FILES.length / 2) : 0;

  return <div className={styles.launch} data-ready={ready} data-error={error !== null} role="dialog" aria-modal="true" aria-labelledby="demo-launch-title">
    <div className={styles.sky} aria-hidden><span /><span /><span /></div>
    <div className={styles.stage}>
      <div className={styles.orbit} style={{ "--progress": progress } as CSSProperties} aria-hidden>
        <svg viewBox="0 0 200 200" className={styles.ring}>
          <defs><linearGradient id="demo-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--brand-from)" /><stop offset="1" stopColor="var(--brand-to)" /></linearGradient></defs>
          <circle cx="100" cy="100" r="92" className={styles.track} />
          <circle cx="100" cy="100" r="92" className={styles.fill} pathLength={1} />
          {DEMO_STAGES.map((item, position) => {
            const angle = (position / DEMO_STAGES.length) * Math.PI * 2 - Math.PI / 2;
            return <circle key={item.step} cx={100 + Math.cos(angle) * 92} cy={100 + Math.sin(angle) * 92} r={completed.has(item.step) ? 4.2 : 2.6}
              className={styles.node} data-done={completed.has(item.step)} data-active={item.step === current && !ready} />;
          })}
        </svg>
        <div className={styles.mark}><HydraMark size={132} live={ready ? ["claude", "codex", "cursor", "grok", "copilot", "kilocode"] : live} /></div>
        {ready && <div className={styles.burst} />}
      </div>

      <p className={styles.eyebrow}>{error ? "Demo" : ready ? "Demo ready" : `Stage ${Math.min(index + 1, DEMO_STAGES.length)} of ${DEMO_STAGES.length}`}</p>
      <h1 id="demo-launch-title" className={styles.title} key={title}>{title}</h1>
      <p className={styles.subtitle} role="status" aria-live="polite">
        {error ?? (ready ? <>Signed in as <b>{username}</b>. Everything you see is yours to click, run and break.</> : "Real files, real commits, real records — written for you right now.")}
      </p>

      <div className={styles.panels}>
        <section className={styles.terminal} aria-label="Preparation log">
          <header><i /><i /><i /><span>hydra demo</span></header>
          <ol ref={logRef}>
            {log.map(line => <li key={line.step} data-tone={line.tone}><span className={styles.tick} aria-hidden>{line.tone === "done" ? "✓" : "›"}</span><code>{line.text}</code></li>)}
            {!ready && !error && <li data-tone="cursor" aria-hidden><span className={styles.tick}>›</span><code className={styles.caret} /></li>}
          </ol>
        </section>
        <section className={styles.manifest} aria-label="What the demo contains">
          <div className={styles.files} aria-label={folder || "Sample project"}>
            <p>{folder ? folder.replace(/\/kettle$/, "/") : "~/hydra-demo/"}</p>
            <ul>{DEMO_FILES.slice(0, filesShown).map(file => <li key={file} style={{ "--delay": `${DEMO_FILES.indexOf(file) * 40}ms` } as CSSProperties}>{file}</li>)}</ul>
          </div>
          <dl className={styles.counters}>
            {DEMO_MANIFEST.map(item => <div key={item.label} data-on={completed.has(item.step)}>
              <dt>{item.label}</dt><dd className="numeric"><CountUp value={completed.has(item.step) ? item.value : 0} durationMs={700} /></dd>
            </div>)}
          </dl>
        </section>
      </div>

      <div className={styles.actions}>
        {ready && <>
          <button ref={enterRef} type="button" className={styles.primary} onClick={() => { try { sessionStorage.setItem(TOUR_AUTOSTART_KEY, "1"); } catch { } onEnter(true); }}>
            Start the guided tour <span aria-hidden>→</span>
          </button>
          <button type="button" className={styles.secondary} onClick={() => onEnter(false)}>Explore on my own</button>
        </>}
        {error && <>
          <button type="button" className={styles.primary} onClick={onRetry}>Try again</button>
          <button type="button" className={styles.secondary} onClick={onCancel}>Back to sign in</button>
        </>}
        {!ready && !error && <p className={styles.hint}>This takes a few seconds. The demo account and its folder are deleted automatically after a day.</p>}
      </div>
    </div>
  </div>;
}
