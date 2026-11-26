"use client";

import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "@/components/ui/icons";

const DOCK_QUERY = "(min-width: 1280px)";

interface Layer {
  target: HTMLElement | null;
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
  label: string;
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
    if (node.open && node.matches(":modal") === docked) node.close();
    if (!node.open) {
      if (docked) {
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
      { }
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

export function DetailReopen({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return <button type="button" className="app-detail-reopen" onClick={onClick}>{children}</button>;
}
