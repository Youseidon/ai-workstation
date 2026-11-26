import type { ReactNode } from "react";

export type SectionId = "chat" | "pipeline" | "activity" | "changes" | "report" | "agents" | "workspaces";

export type SectionScope = "workspace" | "app" | "library";

export interface AppSection {
  id: SectionId;
  scope: SectionScope;
  href: string;
  label: string;
  match: (pathname: string) => boolean;
  icon: ReactNode;
}

export const APP_SECTIONS: AppSection[] = [
  {
    id: "chat",
    scope: "workspace",
    href: "/",
    label: "Chat",
    match: (pathname) => pathname === "/",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H10l-4 3.5V6.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    id: "pipeline",
    scope: "workspace",
    href: "/pipeline",
    label: "Pipeline",
    match: (pathname) =>
      pathname.startsWith("/pipeline") || pathname.startsWith("/tasks") || pathname.startsWith("/operations") || pathname.startsWith("/input"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="6" cy="12" r="2.25" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12" cy="6" r="2.25" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12" cy="18" r="2.25" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="18" cy="12" r="2.25" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8.2 10.8 9.8 7.8M8.2 13.2 9.8 16.2M14.2 7.8l1.6 3M14.2 16.2l1.6-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "activity",
    scope: "workspace",
    href: "/activity",
    label: "Activity",
    match: (pathname) => pathname.startsWith("/activity") || pathname.startsWith("/sessions"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 19V5M4 19h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M8 15v-3M12 15V8M16 15v-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "changes",
    scope: "workspace",
    href: "/changes",
    label: "Changes",
    match: (pathname) => pathname.startsWith("/changes"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M7 4v16M17 4v16M7 8h5a3 3 0 0 1 3 3v2a3 3 0 0 0 3 3h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="7" cy="20" r="2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: "report",
    scope: "workspace",
    href: "/report",
    label: "Report",
    match: (pathname) => pathname.startsWith("/report"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M5 19V9M10 19V5M15 19v-7M20 19V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M4 19h17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "agents",
    scope: "app",
    href: "/agents",
    label: "Agents",
    match: (pathname) => pathname.startsWith("/agents") || pathname.startsWith("/fleet"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="9" r="3.25" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.5 18.5c1.2-2.4 3.1-3.5 5.5-3.5s4.3 1.1 5.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="5.5" cy="10" r="2" stroke="currentColor" strokeWidth="1.4" opacity="0.7" />
        <circle cx="18.5" cy="10" r="2" stroke="currentColor" strokeWidth="1.4" opacity="0.7" />
      </svg>
    ),
  },
  {
    id: "workspaces",
    scope: "library",
    href: "/workspaces",
    label: "Workspaces",
    match: (pathname) => pathname.startsWith("/workspaces"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M12 12v8M12 12 4.5 8M12 12l7.5-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function sectionFor(pathname: string): AppSection | null {
  return APP_SECTIONS.find((section) => section.match(pathname)) ?? null;
}
