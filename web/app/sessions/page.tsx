import { redirect } from "next/navigation";
import { legacyTarget, type SearchParams } from "@/lib/legacyRedirect";

/** Sessions became Activity. */
export default async function SessionsRedirect({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  redirect(legacyTarget("/activity", params));
}
