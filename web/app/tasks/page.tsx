import { redirect } from "next/navigation";
import { legacyTarget, type SearchParams } from "@/lib/legacyRedirect";

/** Tasks merged into Pipeline: the item (or suite) resolves to the pipeline that drives it, or to its suite view. */
export default async function TasksRedirect({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  redirect(Object.keys(params).length === 0 ? "/pipeline" : legacyTarget("/pipeline/open", params));
}
