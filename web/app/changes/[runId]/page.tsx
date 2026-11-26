import { ChangeReview } from "@/features/changes/components/ChangesView";

export default async function ChangeReviewPage({params}:{params:Promise<{runId:string}>}){const {runId}=await params;return <div className="flex h-full flex-col text-fg"><ChangeReview runId={runId}/></div>;}
