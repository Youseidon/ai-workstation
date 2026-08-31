import Link from "next/link";
import { cn } from "@/lib/cn";
import { ThemeToggle } from "./ThemeToggle";

export type NavSection = "console" | "fleet" | "workspaces" | "operations" | "pipeline" | "sessions" | "input";

const LINKS: Array<{ href: string; label: string; matches: NavSection[] }> = [
  { href: "/", label: "Console", matches: ["console"] },
  { href: "/fleet", label: "Fleet", matches: ["fleet"] },
  { href: "/workspaces", label: "Workspaces", matches: ["workspaces"] },
  { href: "/operations", label: "Operations", matches: ["operations", "sessions", "input"] },
  { href: "/pipeline", label: "Pipeline", matches: ["pipeline"] },
];

export function AppNav({ active }: { active: NavSection }) {
  return (
    <div className="flex items-center gap-2">
      <nav
        aria-label="Primary"
        className="flex items-center gap-0.5 rounded-md bg-surface-1 p-0.5 ring-1 ring-inset ring-line"
      >
        {LINKS.map((link) => {
          const current = link.matches.includes(active);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={current ? "page" : undefined}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                current
                  ? "bg-surface-3 text-fg shadow-sm"
                  : "text-fg-dim hover:bg-surface-2 hover:text-fg",
              )}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <ThemeToggle />
    </div>
  );
}
