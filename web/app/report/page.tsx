"use client";

import { PageChrome } from "@/components/shell/chrome";
import { ReportView } from "@/components/report/ReportView";

export default function ReportPage() {
  return (
    <main className="flex h-full flex-col bg-surface-0 text-fg">
      <PageChrome title="Report" />
      <ReportView />
    </main>
  );
}
