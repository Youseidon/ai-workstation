"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

export function UnsavedChangesGuard({ dirty, what, onSave, onDiscard }: {
  dirty: boolean;
  onDiscard?(): void;
  what: string;
  onSave(): Promise<boolean>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (anchor === null || (anchor.target !== "" && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      event.preventDefault();
      event.stopPropagation();
      setPending(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  const leave = (href: string) => { setPending(null); router.push(href); };

  return (
    <Modal
      open={pending !== null}
      onClose={() => { if (!saving) setPending(null); }}
      title="Save your changes?"
      description={`You have unsaved changes to ${what}. Leaving now discards them.`}
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={() => setPending(null)}>Keep editing</Button>
          <Button variant="secondary" disabled={saving} onClick={() => { if (pending !== null) { onDiscard?.(); leave(pending); } }}>Discard changes</Button>
          <Button
            variant="primary"
            loading={saving}
            onClick={async () => {
              if (pending === null) return;
              setSaving(true);
              const saved = await onSave().finally(() => setSaving(false));
              if (saved) leave(pending);
            }}
          >
            Save and leave
          </Button>
        </>
      }
    >
      {null}
    </Modal>
  );
}
