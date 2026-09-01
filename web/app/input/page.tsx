import { redirect } from "next/navigation";

export default async function InputRedirect({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string }>;
}) {
  const { prompt } = await searchParams;
  redirect(`/tasks?filter=attention${prompt ? `&prompt=${encodeURIComponent(prompt)}` : ""}`);
}
