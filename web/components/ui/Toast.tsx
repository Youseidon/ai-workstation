"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useIsClient } from "@/lib/useIsClient";

export type ToastTone = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds. Pass 0 to require an explicit dismiss. */
  duration?: number;
  action?: { label: string; onClick(): void };
}

interface ToastRecord extends Required<Pick<ToastOptions, "title" | "tone" | "duration">> {
  id: number;
  description?: string;
  action?: ToastOptions["action"];
}

interface ToastApi {
  show(options: ToastOptions): number;
  success(title: string, description?: string): number;
  error(title: string, description?: string): number;
  warning(title: string, description?: string): number;
  info(title: string, description?: string): number;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE: Record<ToastTone, { ring: string; text: string; glyph: string }> = {
  success: { ring: "ring-success/40", text: "text-success", glyph: "✓" },
  error: { ring: "ring-danger/40", text: "text-danger", glyph: "✗" },
  warning: { ring: "ring-warning/40", text: "text-warning", glyph: "!" },
  info: { ring: "ring-info/40", text: "text-info", glyph: "i" },
};

/** Errors stay until dismissed; everything else clears itself. */
const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 4000,
  info: 4000,
  warning: 7000,
  error: 0,
};

/**
 * Transient feedback. Replaces the pattern of pinning a red bar to the top of
 * the page for every failure, which pushed the layout down and gave successful
 * actions no feedback at all.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastRecord[]>([]);
  const mounted = useIsClient();
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  // Any toast still pending when the provider unmounts must not fire.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      const tone = options.tone ?? "info";
      const id = nextId.current++;
      const record: ToastRecord = {
        id,
        title: options.title,
        description: options.description,
        tone,
        duration: options.duration ?? DEFAULT_DURATION[tone],
        action: options.action,
      };
      // Cap the stack so a burst of failures cannot cover the app.
      setItems((current) => [...current.slice(-4), record]);
      if (record.duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), record.duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (title, description) => show({ title, description, tone: "success" }),
      error: (title, description) => show({ title, description, tone: "error" }),
      warning: (title, description) => show({ title, description, tone: "warning" }),
      info: (title, description) => show({ title, description, tone: "info" }),
    }),
    [dismiss, show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {mounted &&
        createPortal(
          <div
            role="region"
            aria-label="Notifications"
            className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
          >
            {items.map((item) => {
              const tone = TONE[item.tone];
              return (
                <div
                  key={item.id}
                  role={item.tone === "error" ? "alert" : "status"}
                  aria-live={item.tone === "error" ? "assertive" : "polite"}
                  className={cn(
                    "glass pointer-events-auto flex animate-slide-up items-start gap-3 rounded-lg p-3 shadow-xl ring-1",
                    tone.ring,
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ring-1 ring-inset",
                      tone.text,
                      tone.ring,
                    )}
                  >
                    {tone.glyph}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-fg">{item.title}</p>
                    {item.description !== undefined && (
                      <p className="mt-0.5 break-words text-xs leading-relaxed text-fg-muted">
                        {item.description}
                      </p>
                    )}
                    {item.action !== undefined && (
                      <button
                        type="button"
                        onClick={() => {
                          item.action?.onClick();
                          dismiss(item.id);
                        }}
                        className={cn("mt-2 text-xs font-medium underline-offset-2 hover:underline", tone.text)}
                      >
                        {item.action.label}
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => dismiss(item.id)}
                    aria-label={`Dismiss: ${item.title}`}
                    className="-mr-1 -mt-1 shrink-0 rounded p-1 text-fg-dim transition-colors hover:bg-surface-3 hover:text-fg"
                  >
                    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
                      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (context === null) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}
