import { PageChrome } from "@/components/shell/chrome";
import { ActivityView } from "@/components/activity/ActivityView";

export default async function ActivityPage({searchParams}:{searchParams:Promise<{run?:string|string[]}>}) {
  const value=(await searchParams).run;
  const runId=typeof value==="string"&&value!==""?value:null;
  return (
    <main className="flex h-full flex-col bg-surface-0 text-fg">
      <PageChrome title="Activity" />
      <ActivityView initialRunId={runId} />
    </main>
  );
}
