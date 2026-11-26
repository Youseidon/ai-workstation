import { ActivityView } from "@/features/activity/components/ActivityView";

export default async function ActivityPage({searchParams}:{searchParams:Promise<{run?:string|string[]}>}) {
  const value=(await searchParams).run;
  const runId=typeof value==="string"&&value!==""?value:null;
  return (
    <div className="flex h-full flex-col text-fg">
      <ActivityView initialRunId={runId} />
    </div>
  );
}
