"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface ChromePage {
  title: string;
  breadcrumb: ReactNode;
  actions: ReactNode;
}

interface ChromeDispatch {
  setPage(page: ChromePage): void;
  openSettings(): void;
  closeSettings(): void;
}

const EMPTY: ChromePage = { title: "", breadcrumb: null, actions: null };

const ChromeDispatchContext = createContext<ChromeDispatch | null>(null);
const ChromePageContext = createContext<ChromePage>(EMPTY);
const ChromeSettingsContext = createContext(false);

/**
 * Pages publish their title, breadcrumb and toolbar actions into the top bar
 * through this context rather than portals — one tree, one owner.
 *
 * Dispatch, page claim and settings are separate contexts so that:
 * - PageChrome (dispatch only) does not re-render when the claim updates
 * - AppShell / Sidebar do not re-render when a page publishes actions
 * - only TopBar re-renders for claim changes
 *
 * A single context value caused an infinite loop whenever `actions` was inline JSX.
 */
export function ChromeProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<ChromePage>(EMPTY);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const dispatch = useMemo<ChromeDispatch>(
    () => ({
      setPage,
      openSettings: () => setSettingsOpen(true),
      closeSettings: () => setSettingsOpen(false),
    }),
    [],
  );

  return (
    <ChromeDispatchContext.Provider value={dispatch}>
      <ChromeSettingsContext.Provider value={settingsOpen}>
        <ChromePageContext.Provider value={page}>{children}</ChromePageContext.Provider>
      </ChromeSettingsContext.Provider>
    </ChromeDispatchContext.Provider>
  );
}

export function useChromeDispatch(): ChromeDispatch {
  const dispatch = useContext(ChromeDispatchContext);
  if (dispatch === null) throw new Error("useChromeDispatch must be used inside <ChromeProvider>");
  return dispatch;
}

export function useChromePage(): ChromePage {
  return useContext(ChromePageContext);
}

export function useChromeSettingsOpen(): boolean {
  return useContext(ChromeSettingsContext);
}

/** @deprecated Prefer the split hooks; kept for call sites that need everything. */
export function useChrome(): ChromeDispatch & { page: ChromePage; settingsOpen: boolean } {
  return {
    ...useChromeDispatch(),
    page: useChromePage(),
    settingsOpen: useChromeSettingsOpen(),
  };
}

export function useChromeState(): { page: ChromePage; settingsOpen: boolean } {
  return { page: useChromePage(), settingsOpen: useChromeSettingsOpen() };
}

/**
 * A page mounts this to claim the top bar. Cleanup clears the claim on leave so
 * a stale title never outlives its route.
 */
export function PageChrome({
  title,
  breadcrumb,
  actions,
}: {
  title: string;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
}) {
  const { setPage } = useChromeDispatch();

  useLayoutEffect(() => {
    setPage({ title, breadcrumb: breadcrumb ?? null, actions: actions ?? null });
  }, [title, breadcrumb, actions, setPage]);

  // Clear only on unmount — clearing on every actions identity change was
  // racing with the publish above and amplifying update loops.
  useLayoutEffect(() => {
    return () => setPage(EMPTY);
  }, [setPage]);

  return null;
}

/** Stable helper for pages that only need to open settings from a local button. */
export function useOpenSettings(): () => void {
  const { openSettings } = useChromeDispatch();
  return useCallback(() => openSettings(), [openSettings]);
}
