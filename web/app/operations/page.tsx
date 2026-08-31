import { Suspense } from "react";
import { OperationsView } from "./OperationsView";

/**
 * `useSearchParams` makes the tree below it client-rendered, so it needs a
 * Suspense boundary. Reading the deep-link parameters this way — rather than
 * poking at `window.location` inside an effect — is what lets the view derive
 * its selection during render instead of correcting it afterwards.
 */
export default function OperationsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-fg-dim">Loading operations…</div>}>
      <OperationsView />
    </Suspense>
  );
}
