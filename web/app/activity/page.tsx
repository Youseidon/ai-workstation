import { ContentTitle } from "@/components/shell/PageCanvas";
import { ActivityView } from "@/components/activity/ActivityView";

export default async function ActivityPage({searchParams}:{searchParams:Promise<{run?:string|string[]}>}) {
  const value=(await searchParams).run;
  const runId=typeof value==="string"&&value!==""?value:null;
  return (
    <div className="flex h-full flex-col text-fg">
      <ContentTitle title="Activity" />
      <ActivityView initialRunId={runId} />
    </div>
  );
}
