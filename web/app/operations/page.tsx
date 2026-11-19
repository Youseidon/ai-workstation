import { redirect } from "next/navigation";
import { legacyTarget, type SearchParams } from "@/lib/legacyRedirect";

/** Operations merged into Pipeline; a linked item or suite resolves like a Tasks link. */
export default async function OperationsRedirect({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  redirect(Object.keys(params).length === 0 ? "/pipeline" : legacyTarget("/pipeline/open", params));
}
