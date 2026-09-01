import { redirect } from "next/navigation";

export default async function OperationsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") q.set(k, v);
  }
  const qs = q.toString();
  redirect(qs ? `/tasks?${qs}` : "/tasks");
}
