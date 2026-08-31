"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False during server rendering and the first hydration pass, true afterwards.
 *
 * Portals need a real `document`, and the usual `useState` + `useEffect(set)`
 * dance to detect that renders an extra frame and trips React's
 * cascading-render rule. This asks the question directly instead.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
