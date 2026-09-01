"use client";

import { PageChrome } from "@/components/shell/chrome";
import { ActivityView } from "@/components/activity/ActivityView";

export default function ActivityPage() {
  return (
    <main className="flex h-full flex-col bg-surface-0 text-fg">
      <PageChrome title="Activity" />
      <ActivityView />
    </main>
  );
}
