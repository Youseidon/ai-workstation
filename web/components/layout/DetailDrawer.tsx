"use client";

import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "@/components/ui/icons";

/**
 * The one on-demand detail drawer: station details, policy, verification,
 * metadata. The shell owns where it sits; a route owns what is in it.
 *
 * At 1280 px and wider it docks as a column beside the content and leaves the
 * content interactive (non-modal), so selecting another record updates it in
 * place. Narrower, it is a modal sheet that uses the available viewport,
 * contains focus, and closes on Escape or the backdrop.
 */
const DOCK_QUERY = "(min-width: 1280px)";

interface Layer {
  target: HTMLElement | null;
  /** True while another shared drawer (attention) is open: only one shows at a time. */
  suspended: boolean;
}
const LayerContext = createContext<Layer>({ target: null, suspended: false });
export const DetailLayerProvider = LayerContext.Provider;

function subscribe(callback: () => void) {
  const media = matchMedia(DOCK_QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

export function useDetailDocked(): boolean {
  return useSyncExternalStore(subscribe, () => matchMedia(DOCK_QUERY).matches, () => true);
}

export function DetailDrawer({ open, onClose, label, header, children }: {
  open: boolean;
  onClose(): void;
  /** Accessible name for the drawer. */
  label: string;
  /** Title or mode tabs, beside the one close control. */
  header: ReactNode;
  children: ReactNode;
}) {
  const { target: layer, suspended } = useContext(LayerContext);
  const shown = open && !suspended;
  const docked = useDetailDocked();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (node === null) return;
    if (!shown) { if (node.open) node.close(); return; }
    // Switching between docked and sheet changes modality: reopen in the right mode.
    if (node.open && node.matches(":modal") === docked) node.close();
    if (!node.open) {
      if (docked) {
        // A docked drawer sits beside the content: opening it must not take
        // focus away from the board (keyboard selection keeps working).
        const previous = document.activeElement;
        node.show();
        if (previous instanceof HTMLElement && previous !== document.body) previous.focus({ preventScroll: true });
        else (document.activeElement as HTMLElement | null)?.blur();
      } else node.showModal();
    }
  }, [shown, docked, layer]);

  if (layer === null) return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="app-detail"
      aria-label={label}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && docked) { event.stopPropagation(); onClose(); } }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      {/* Mounted while open, even when suspended, so drafts inside the drawer survive. */}
      {open && <div className="app-detail-body">
        <div className="app-detail-header">
          <div className="min-w-0 flex-1">{header}</div>
          <button type="button" className="app-icon-button" aria-label="Close details" title="Close (Esc)" onClick={onClose}><CloseIcon /></button>
        </div>
        <div className="app-detail-content">{children}</div>
      </div>}
    </dialog>,
    layer,
  );
}

/** Reopens a closed drawer. Lives with the content it opens, in the same place on every page. */
export function DetailReopen({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return <button type="button" className="app-detail-reopen" onClick={onClick}>{children}</button>;
}
