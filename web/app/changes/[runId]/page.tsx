import { ChangeReview } from "@/components/changes/ChangesView";

export default async function ChangeReviewPage({params}:{params:Promise<{runId:string}>}){const {runId}=await params;return <main className="flex h-full flex-col bg-surface-0 text-fg"><ChangeReview runId={runId}/></main>;}
