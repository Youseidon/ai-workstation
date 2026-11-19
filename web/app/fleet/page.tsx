import { redirect } from "next/navigation";
import { legacyTarget, type SearchParams } from "@/lib/legacyRedirect";

/** Fleet became Agents. */
export default async function FleetRedirect({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  redirect(legacyTarget("/agents", params));
}
