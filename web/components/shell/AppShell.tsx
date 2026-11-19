"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ChatStage } from "@/components/chat/ChatStage";
import { ChatProvider, useChat } from "@/lib/chatController";
import { sectionFor } from "@/lib/navigation";
import { AppSidebar, useSidebarState } from "./AppSidebar";
import { RunAttentionDrawer } from "./RunAttention";
import { DetailLayerProvider } from "./DetailDrawer";
import { SidebarSlotProvider } from "./SidebarCollection";

/** Applies Chat deep links that arrive by client navigation after Chat started. */
function ChatLinkSync({ active }: { active: boolean }) {
  const search = useSearchParams().toString();
  const { started, openLink } = useChat();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !started) { seen.current = null; return; }
    if (seen.current === search) return;
    const first = seen.current === null;
    seen.current = search;
    // The first visit's link was read when Chat started.
    if (!first) openLink(`?${search}`);
  }, [active, started, search, openLink]);
  return null;
}

function ChatStageMount({ visible }: { visible: boolean }) {
  const { started } = useChat();
  return started ? <ChatStage visible={visible} /> : null;
}

/**
 * The one application shell, mounted above every route: the shared sidebar,
 * the single `main` landmark and the shared overlay layer. Routes render
 * content only; they never install another sidebar, header or viewport.
 *
 * Chat's conversations live here rather than in the `/` route so leaving Chat
 * keeps running conversations, drafts and queued messages mounted.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  const chat = section?.id === "chat";
  const sidebar = useSidebarState(pathname);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [asideSlot, setAsideSlot] = useState<HTMLDivElement | null>(null);
  const [drawerSlot, setDrawerSlot] = useState<HTMLDivElement | null>(null);
  const [detailLayer, setDetailLayer] = useState<HTMLDivElement | null>(null);
  const detailLayerValue = useMemo(() => ({ target: detailLayer, suspended: attentionOpen }), [detailLayer, attentionOpen]);
  const slot = useMemo(() => ({
    target: sidebar.drawerOpen && drawerSlot !== null ? drawerSlot : asideSlot,
    onNavigate: sidebar.closeDrawer,
  }), [sidebar.drawerOpen, sidebar.closeDrawer, drawerSlot, asideSlot]);

  // Track the visual viewport so the mobile keyboard never hides the content's bottom edge.
  useEffect(() => {
    if (!window.visualViewport) return;
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.style.setProperty("--app-viewport-height", `${viewport.height}px`);
    resize(); viewport.addEventListener("resize", resize);
    return () => { viewport.removeEventListener("resize", resize); document.documentElement.style.removeProperty("--app-viewport-height"); };
  }, []);

  return (
    <ChatProvider active={chat}>
      <Suspense fallback={null}><ChatLinkSync active={chat} /></Suspense>
      <SidebarSlotProvider value={slot}>
      <DetailLayerProvider value={detailLayerValue}>
      <div className="app-shell" data-collapsed={sidebar.collapsed}>
        <AppSidebar section={section} state={sidebar} onAttention={() => setAttentionOpen(true)} asideSlot={setAsideSlot} drawerSlot={setDrawerSlot} />
        <main className="app-main">
          <ChatStageMount visible={chat} />
          <div className="app-route" hidden={chat}>{children}</div>
        </main>
        {/* The shared detail drawer docks here; routes portal their detail into it. */}
        <div ref={setDetailLayer} className="app-detail-layer" />
        <RunAttentionDrawer open={attentionOpen} onClose={() => setAttentionOpen(false)} />
      </div>
      </DetailLayerProvider>
      </SidebarSlotProvider>
    </ChatProvider>
  );
}
