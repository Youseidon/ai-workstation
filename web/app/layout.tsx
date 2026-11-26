import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono, Unbounded } from "next/font/google";
import { AppShell } from "@/components/layout/AppShell";
import { ThemeScript } from "@/components/theme/ThemeScript";
import { DialogProvider } from "@/components/ui/Dialogs";
import { ToastProvider } from "@/components/ui/Toast";
import { HydraProvider } from "@/contexts/hydra";
import { IdentityGate } from "@/contexts/identity";
import { WorkspaceProvider, WorkspaceUrlSync } from "@/contexts/workspaceContext";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// The brand display face: page titles and brand moments only (brand/README.md).
const unbounded = Unbounded({ variable: "--font-unbounded", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Hydra", template: "%s · Hydra" },
  applicationName: "Hydra",
  description: "Many heads. One console. A live console for local CLI coding agents.",
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
      className={`${geistSans.variable} ${geistMono.variable} ${unbounded.variable} h-full antialiased`}
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
            <IdentityGate>
            <HydraProvider>
              <WorkspaceProvider>
                <Suspense fallback={null}>
                  <WorkspaceUrlSync />
                </Suspense>
                <AppShell>{children}</AppShell>
              </WorkspaceProvider>
            </HydraProvider>
            </IdentityGate>
          </DialogProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
