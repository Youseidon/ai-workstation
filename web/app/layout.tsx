import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Agent Console",
  description: "Live console for local CLI coding agents",
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
       * a real mismatch anywhere inside still surfaces.
       */}
      <body className="min-h-full" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
