import { redirect } from "next/navigation";
import { legacyTarget, type SearchParams } from "@/lib/legacyRedirect";

/** The input queue became Pipeline's Needs-you filter. */
export default async function InputRedirect({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  redirect(legacyTarget("/pipeline/open", params, { filter: "attention" }));
}
