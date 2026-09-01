"use client";

import {
  createContext,
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
}

const EMPTY: ChromePage = { title: "", breadcrumb: null, actions: null };

const ChromeDispatchContext = createContext<ChromeDispatch | null>(null);
const ChromePageContext = createContext<ChromePage>(EMPTY);

/**
 * Pages publish their title, breadcrumb and toolbar actions into the top bar
 * through this context rather than portals — one tree, one owner.
 *
 * Dispatch and page claim are separate contexts so that:
 * - PageChrome (dispatch only) does not re-render when the claim updates
 * - AppShell / Sidebar do not re-render when a page publishes actions
 * - only TopBar re-renders for claim changes
 *
 * A single context value caused an infinite loop whenever `actions` was inline JSX.
 */
export function ChromeProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<ChromePage>(EMPTY);

  const dispatch = useMemo<ChromeDispatch>(() => ({ setPage }), []);

  return (
    <ChromeDispatchContext.Provider value={dispatch}>
      <ChromePageContext.Provider value={page}>{children}</ChromePageContext.Provider>
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
