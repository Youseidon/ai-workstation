"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { ProviderId } from "@hydra/shared";
import { HydraMark } from "@/components/brand/HydraMark";
import { useIdentity } from "@/contexts/identity";
import { useWorkspace } from "@/contexts/workspaceContext";
import { userLocalStorage } from "@/lib/identityStorage";
import { TOUR_AUTOSTART_KEY } from "@/features/demo/lib/demoLaunch";
import {
  CHAPTERS, EMPTY_PROGRESS, TOUR_STEPS, TOUR_STORAGE_KEY, chapterOf, chapterSteps, chaptersDone, firstStepOf, inlineMarks, locationMatches,
  parseProgress, placeCard, stepBody, unionRect, type ChapterId, type Rect, type Side, type TourContext, type TourLocation, type TourProgress, type TourStep,
} from "../lib/tour";
import styles from "./tour.module.css";

interface TourApi { progress: TourProgress; start(chapter?: ChapterId): void; openMap(): void }
const TourApiContext = createContext<TourApi | null>(null);
export function useTour(): TourApi {
  const value = useContext(TourApiContext);
  if (!value) throw new Error("Tour provider is required");
  return value;
}

const TICK_MS = 120;
const DONE_HOLD_MS = 1100;

function visible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
}

/** A selector lights its first visible match; a comma list lights the first visible match of each part. */
function resolveTarget(selectors: readonly string[] | undefined): { rect: Rect | null; element: Element | null } {
  for (const selector of selectors ?? []) {
    const found: Element[] = [];
    for (const part of selector.split(",")) {
      try {
        const match = [...document.querySelectorAll(part.trim())].find(visible);
        if (match) found.push(match);
      } catch { /* a selector the browser rejects simply matches nothing */ }
    }
    if (found.length > 0) {
      const rect = unionRect(found.map(element => { const box = element.getBoundingClientRect(); return { top: box.top, left: box.left, width: box.width, height: box.height }; }));
      return { rect, element: found[0]! };
    }
  }
  return { rect: null, element: null };
}

function firstVisible(selector: string): Element | null {
  try { return [...document.querySelectorAll(selector)].find(visible) ?? null; } catch { return null; }
}

function currentLocation(): TourLocation { return { pathname: window.location.pathname, search: window.location.search }; }

function Copy({ text }: { text: string }) {
  return <>{inlineMarks(text).map((part, index) => part.kind === "bold" ? <strong key={index}>{part.text}</strong> : part.kind === "code" ? <code key={index}>{part.text}</code> : <span key={index}>{part.text}</span>)}</>;
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.round(a.top) === Math.round(b.top) && Math.round(a.left) === Math.round(b.left) && Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);
}

function TourOverlay({ index, progress, context, onNext, onBack, onClose }: {
  index: number; progress: TourProgress; context: TourContext;
  onNext(didTask: boolean): void; onBack(): void; onClose(): void;
}) {
  const router = useRouter();
  const step: TourStep = TOUR_STEPS[index]!;
  const chapter = chapterOf(step.chapter);
  const steps = chapterSteps(step.chapter);
  const position = steps.indexOf(index);
  const chapterNumber = CHAPTERS.findIndex(item => item.id === chapter.id) + 1;
  const card = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [beacon, setBeacon] = useState<{ x: number; y: number } | null>(null);
  const [location, setLocation] = useState<TourLocation>(() => currentLocation());
  const [placement, setPlacement] = useState<{ top: number; left: number; side: Side }>({ top: 0, left: 0, side: "center" });
  const [done, setDone] = useState(false);
  const scrolled = useRef(false);
  const task = step.task;
  const away = step.route !== undefined && task?.kind !== "route" && !locationMatches(step.route, location);
  const lit = useMemo(() => chaptersDone(index, false).map(id => chapterOf(id).head), [index]);
  const markHeads: ProviderId[] = done && position === steps.length - 1 ? [...lit, chapter.head] : lit;

  // One timer drives everything that depends on the live page: where the
  // target is, where the card fits, the URL, and whether a typed or routed
  // task has been satisfied. Pages render asynchronously, so polling is the
  // honest way to notice a target that appears a moment after navigation.
  useEffect(() => {
    const tick = () => {
      const next = resolveTarget(away ? undefined : step.target);
      setRect(previous => sameRect(previous, next.rect) ? previous : next.rect);
      if (next.element && !scrolled.current) {
        scrolled.current = true;
        const box = next.element.getBoundingClientRect();
        if (box.top < 0 || box.bottom > window.innerHeight) next.element.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      const here = currentLocation();
      setLocation(previous => previous.pathname === here.pathname && previous.search === here.search ? previous : here);
      if (task?.kind === "click" && !away) {
        const element = firstVisible(task.selector);
        const box = element?.getBoundingClientRect();
        setBeacon(previous => {
          const value = box ? { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } : null;
          return previous?.x === value?.x && previous?.y === value?.y ? previous : value;
        });
      } else setBeacon(null);
      if (task?.kind === "route" && locationMatches(task.route, here)) setDone(true);
      if (task?.kind === "input") {
        const field = firstVisible(task.selector) as HTMLTextAreaElement | HTMLInputElement | null;
        if (field && field.value.trim().length > 0) setDone(true);
      }
      const size = card.current ? { width: card.current.offsetWidth, height: card.current.offsetHeight } : { width: 360, height: 260 };
      const view = { width: window.innerWidth, height: window.innerHeight };
      const spot = next.rect && { top: next.rect.top - 6, left: next.rect.left - 6, width: next.rect.width + 12, height: next.rect.height + 12 };
      const huge = spot !== null && spot.width * spot.height > view.width * view.height * 0.45;
      const placed = placeCard(huge ? null : spot, size, view);
      const corner = huge ? { side: "center" as const, top: view.height - size.height - 24, left: view.width - size.width - 24 } : placed;
      setPlacement(previous => previous.top === Math.round(corner.top) && previous.left === Math.round(corner.left) && previous.side === corner.side ? previous : { top: Math.round(corner.top), left: Math.round(corner.left), side: corner.side });
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    window.addEventListener("resize", tick);
    return () => { clearInterval(timer); window.removeEventListener("resize", tick); };
  }, [step, task, away]);

  // The tour opens the section menu in one step; a later step that is not
  // about it must not leave it covering the sidebar it points at.
  useEffect(() => {
    if (step.target?.some(selector => selector.includes(".app-section-menu"))) return;
    // A pointer press outside is the switcher's own "close", and unlike a
    // toggle click it is idempotent, so a repeated effect cannot reopen it.
    if (document.querySelector('.app-section-current[aria-expanded="true"]')) document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  }, [step]);

  useEffect(() => {
    if (task?.kind !== "click") return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(task.selector) && !card.current?.contains(target)) setDone(true);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [task]);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => onNext(true), DONE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [done, onNext]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
      if (event.key === "Escape") { onClose(); return; }
      if (typing) return;
      if (event.key === "ArrowRight") { event.preventDefault(); onNext(false); }
      if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); onBack(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, onBack, onClose, onNext]);

  const spot = rect && !away ? { top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 } : null;
  const last = index === TOUR_STEPS.length - 1;
  const firstOfChapter = position === 0;

  return <div className={styles.layer} data-step={step.id}>
    <div className={styles.spotlight} data-empty={spot === null} data-done={done}
      style={spot ? { top: spot.top, left: spot.left, width: spot.width, height: spot.height, "--head": `var(--agent-${chapter.head})` } as CSSProperties : { "--head": `var(--agent-${chapter.head})` } as CSSProperties} />
    {beacon && !done && <span className={styles.beacon} style={{ left: beacon.x, top: beacon.y, "--head": `var(--agent-${chapter.head})` } as CSSProperties} aria-hidden><i /><i /></span>}
    <div ref={card} className={styles.card} data-side={placement.side} data-done={done} data-opener={firstOfChapter}
      style={{ top: placement.top, left: placement.left, "--head": `var(--agent-${chapter.head})` } as CSSProperties}
      role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body">
      <div className={styles.cardGlow} aria-hidden />
      <header className={styles.cardHead}>
        <HydraMark size={30} live={markHeads.length > 0 ? markHeads : undefined} tone="mono" className={styles.cardMark} />
        <div className={styles.cardEyebrow}>
          <span>Chapter {chapterNumber} of {CHAPTERS.length}</span>
          <strong>{chapter.title}</strong>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Pause the tour" title="Pause the tour (Esc)">✕</button>
      </header>
      <h2 id="tour-title" className={styles.cardTitle} key={step.id}>{step.title}</h2>
      <p id="tour-body" className={styles.cardBody}><Copy text={stepBody(step, context)} /></p>
      {away && step.href && <div className={styles.away}>
        <span>This stop is on another page.</span>
        <button type="button" onClick={() => router.push(step.href!)}>Take me there →</button>
      </div>}
      {task && !away && <div className={styles.task} data-done={done} role="status" aria-live="polite">
        <span className={styles.taskIcon} aria-hidden>{done ? "✓" : "▸"}</span>
        <span className={styles.taskText}><small>{done ? "It works" : "Your move"}</small>{done ? "Nice — that was the real thing." : task.label}</span>
      </div>}
      <footer className={styles.cardFoot}>
        <ol className={styles.dots} aria-label={`Step ${position + 1} of ${steps.length} in this chapter`}>
          {steps.map((stepIndex, dot) => <li key={stepIndex} data-state={dot < position ? "past" : dot === position ? "now" : "next"} />)}
        </ol>
        <div className={styles.buttons}>
          {index > 0 && <button type="button" className={styles.ghost} onClick={onBack}>Back</button>}
          <button type="button" className={styles.next} onClick={() => onNext(false)}>
            {last ? "Finish" : task && !done ? "Skip" : "Next"}
          </button>
        </div>
      </footer>
      <p className={styles.keys} aria-hidden><kbd>←</kbd><kbd>→</kbd> move · <kbd>Esc</kbd> pause · {progress.tasksDone} done for real</p>
    </div>
  </div>;
}

function ChapterMap({ progress, onPick, onClose }: { progress: TourProgress; onPick(chapter?: ChapterId): void; onClose(): void }) {
  const done = new Set(chaptersDone(progress.step, progress.completed));
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className={styles.scrim} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.map} role="dialog" aria-modal="true" aria-labelledby="tour-map-title">
      <button type="button" className={styles.close} onClick={onClose} aria-label="Close">✕</button>
      <HydraMark size={72} live={[...done].map(id => chapterOf(id).head)} tone="mono" />
      <h2 id="tour-map-title">Six heads, six chapters</h2>
      <p>Each chapter wakes one head. Start from the top, or jump straight to what you came for.</p>
      <ol className={styles.chapters}>
        {CHAPTERS.map((chapter, number) => <li key={chapter.id}>
          <button type="button" onClick={() => onPick(chapter.id)} style={{ "--head": `var(--agent-${chapter.head})` } as CSSProperties} data-done={done.has(chapter.id)}>
            <span className={styles.chapterNumber}>{done.has(chapter.id) ? "✓" : number + 1}</span>
            <span><strong>{chapter.title}</strong><small>{chapter.tagline}</small></span>
            <span className={styles.chapterCount}>{chapterSteps(chapter.id).length} stops</span>
          </button>
        </li>)}
      </ol>
      <button ref={first} type="button" className={styles.primary} onClick={() => onPick()}>
        {progress.completed ? "Replay from the beginning" : progress.step > 0 ? "Start over from the beginning" : "Start the tour"} <span aria-hidden>→</span>
      </button>
      {progress.step > 0 && !progress.completed && <button type="button" className={styles.ghost} onClick={() => onPick(TOUR_STEPS[progress.step]?.chapter)}>Resume where I left off</button>}
    </div>
  </div>;
}

// Deterministic sparks: index-derived positions keep render pure.
const SPARKS = Array.from({ length: 36 }, (_, index) => ({ x: (index * 37) % 100, delay: (index * 53) % 900, drift: ((index * 29) % 60) - 30, head: CHAPTERS[index % CHAPTERS.length]!.head }));

function Finale({ tasksDone, onClose, onReplay }: { tasksDone: number; onClose(): void; onReplay(): void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { button.current?.focus(); }, []);
  return <div className={styles.scrim}>
    <div className={styles.sparks} aria-hidden>{SPARKS.map((spark, index) => <i key={index} style={{ left: `${spark.x}%`, animationDelay: `${spark.delay}ms`, "--drift": `${spark.drift}vw`, background: `var(--agent-${spark.head})` } as CSSProperties} />)}</div>
    <div className={styles.finale} role="dialog" aria-modal="true" aria-labelledby="tour-finale-title">
      <HydraMark size={112} live={CHAPTERS.map(chapter => chapter.head)} />
      <p className={styles.finaleEyebrow}>Tour complete</p>
      <h2 id="tour-finale-title">Every head is awake</h2>
      <p>You toured all six chapters{tasksDone > 0 ? <> and did <strong>{tasksDone}</strong> {tasksDone === 1 ? "thing" : "things"} for real along the way</> : null}. The rest is yours: point a workspace at a project and hand an agent its first task.</p>
      <div className={styles.finaleActions}>
        <button ref={button} type="button" className={styles.primary} onClick={onClose}>Back to Hydra <span aria-hidden>→</span></button>
        <button type="button" className={styles.ghost} onClick={onReplay}>Replay the tour</button>
      </div>
    </div>
  </div>;
}

function Invite({ progress, onStart, onDismiss }: { progress: TourProgress; onStart(): void; onDismiss(): void }) {
  const resuming = progress.step > 0;
  return <div className={styles.invite} role="complementary" aria-label="Guided tour">
    <button type="button" className={styles.inviteMain} onClick={onStart}>
      <HydraMark size={28} tone="spectrum" />
      <span><strong>{resuming ? "Resume the tour" : "New here? Take the tour"}</strong><small>{resuming ? `Chapter: ${chapterOf(TOUR_STEPS[progress.step]!.chapter).title}` : "Six short chapters · about 4 minutes"}</small></span>
    </button>
    <button type="button" className={styles.inviteClose} onClick={onDismiss} aria-label="Hide the tour invitation">✕</button>
  </div>;
}

export function TourProvider({ children }: { children: ReactNode }) {
  const { user } = useIdentity();
  const { workspace } = useWorkspace();
  const [progress, setProgress] = useState<TourProgress>(EMPTY_PROGRESS);
  const [loaded, setLoaded] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [finale, setFinale] = useState(false);
  const progressRef = useRef(EMPTY_PROGRESS);

  useEffect(() => {
    // Storage is per account and only exists in the browser; read it after mount.
    const timer = setTimeout(() => {
      let autostart = false;
      try { autostart = sessionStorage.getItem(TOUR_AUTOSTART_KEY) === "1"; sessionStorage.removeItem(TOUR_AUTOSTART_KEY); } catch { }
      let stored = EMPTY_PROGRESS;
      try { stored = parseProgress(userLocalStorage.getItem(TOUR_STORAGE_KEY)); } catch { }
      const initial = autostart ? { ...EMPTY_PROGRESS, active: true } : stored;
      progressRef.current = initial;
      setProgress(initial);
      setLoaded(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const save = useCallback((update: (current: TourProgress) => TourProgress) => {
    const next = update(progressRef.current);
    progressRef.current = next;
    setProgress(next);
    try { userLocalStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(next)); } catch { }
  }, []);

  const start = useCallback((chapter?: ChapterId) => {
    setMapOpen(false); setFinale(false);
    save(current => ({ ...current, active: true, completed: chapter ? current.completed : false, step: chapter ? firstStepOf(chapter) : 0, tasksDone: chapter ? current.tasksDone : 0 }));
  }, [save]);
  const next = useCallback((didTask: boolean) => {
    const finishing = progressRef.current.step >= TOUR_STEPS.length - 1;
    save(current => {
      const tasksDone = current.tasksDone + (didTask ? 1 : 0);
      return finishing ? { ...current, active: false, completed: true, step: 0, tasksDone } : { ...current, step: current.step + 1, tasksDone };
    });
    if (finishing) setFinale(true);
  }, [save]);
  const back = useCallback(() => save(current => ({ ...current, step: Math.max(0, current.step - 1) })), [save]);
  const close = useCallback(() => save(current => ({ ...current, active: false })), [save]);
  const dismiss = useCallback(() => save(current => ({ ...current, dismissed: true })), [save]);

  const context = useMemo<TourContext>(() => ({ demo: user.demo === true, workspaceName: workspace?.name ?? null, workDirectory: workspace?.workDirectory ?? null }), [user.demo, workspace?.name, workspace?.workDirectory]);
  const api = useMemo<TourApi>(() => ({ progress, start, openMap: () => setMapOpen(true) }), [progress, start]);
  const showInvite = loaded && !progress.active && !progress.completed && !progress.dismissed && !mapOpen && !finale;

  return <TourApiContext.Provider value={api}>
    {children}
    {loaded && typeof document !== "undefined" && createPortal(<>
      {progress.active && <TourOverlay key={progress.step} index={progress.step} progress={progress} context={context} onNext={next} onBack={back} onClose={close} />}
      {mapOpen && <ChapterMap progress={progress} onPick={start} onClose={() => setMapOpen(false)} />}
      {finale && <Finale tasksDone={progress.tasksDone} onClose={() => setFinale(false)} onReplay={() => start()} />}
      {showInvite && <Invite progress={progress} onStart={() => { if (progress.step > 0) save(current => ({ ...current, active: true })); else start(); }} onDismiss={dismiss} />}
    </>, document.body)}
  </TourApiContext.Provider>;
}

/** Sidebar entry: opens the chapter map. */
export function TourButton() {
  const { openMap, progress } = useTour();
  const done = chaptersDone(progress.step, progress.completed).length;
  return <button type="button" data-tour="tour-button" className={styles.sidebarButton} onClick={openMap}
    title="Guided tour: replay it or jump to a chapter">
    <span className={styles.sidebarHeads} aria-hidden>{CHAPTERS.map((chapter, number) => <i key={chapter.id} data-on={number < done} style={{ "--head": `var(--agent-${chapter.head})` } as CSSProperties} />)}</span>
    <span>{progress.completed ? "Replay the tour" : progress.step > 0 ? "Continue the tour" : "Take the tour"}</span>
  </button>;
}
