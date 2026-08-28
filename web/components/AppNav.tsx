import Link from "next/link";

export function AppNav({ active }: { active: "console" | "workspaces" }) {
  return <nav className="flex items-center gap-1 rounded border border-[#1d2229] bg-[#0b0d10] p-0.5 text-xs">
    <Link href="/" className={`rounded px-2.5 py-1 ${active === "console" ? "bg-[#20262e] text-[#e7ecf2]" : "text-[#7d8794] hover:text-[#d7dde5]"}`}>Console</Link>
    <Link href="/workspaces" className={`rounded px-2.5 py-1 ${active === "workspaces" ? "bg-[#20262e] text-[#e7ecf2]" : "text-[#7d8794] hover:text-[#d7dde5]"}`}>Workspaces</Link>
  </nav>;
}
