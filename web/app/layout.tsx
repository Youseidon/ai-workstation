import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShell } from "@/components/shell/AppShell";
import { ThemeScript } from "@/components/ThemeScript";
import { DialogProvider } from "@/components/ui/Dialogs";
import { ToastProvider } from "@/components/ui/Toast";
import { AgentConsoleProvider } from "@/lib/agentConsole";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Agent Console",
  description: "Live console for local CLI coding agents",
};

export const viewport: Viewport = {
  // Matches the darkest theme's floor so mobile browser chrome does not flash
  // white around the app.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#12151c" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      {/*
       * Browser extensions (Grammarly, password managers, dark-mode add-ons)
       * stamp attributes onto <html> and <body> before React hydrates, which
       * React reports as a hydration mismatch. suppressHydrationWarning applies
       * to these two elements only — one level deep, never to the app tree — so
       * a real mismatch anywhere inside still surfaces. ThemeScript writes
       * data-theme/data-effects onto <html> for the same reason.
       */}
      <body className="min-h-full" suppressHydrationWarning>
        <ThemeScript />
        <ToastProvider>
          <DialogProvider>
            {/*
             * One socket for the whole app, owned above the router so that
             * navigating between pages does not tear it down and lose the
             * transcript of a run that is still going.
             */}
            <AgentConsoleProvider>
              <AppShell>{children}</AppShell>
            </AgentConsoleProvider>
          </DialogProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
