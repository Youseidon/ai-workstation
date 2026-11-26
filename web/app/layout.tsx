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
const unbounded = Unbounded({ variable: "--font-unbounded", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Hydra", template: "%s · Hydra" },
  applicationName: "Hydra",
  description: "Many heads. One console. A live console for local CLI coding agents.",
};

export const viewport: Viewport = {
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
      { }
      <body className="min-h-full" suppressHydrationWarning>
        <ThemeScript />
        <ToastProvider>
          <DialogProvider>
            { }
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
