import Link from "next/link";
import { PageState } from "@/components/layout/PageCanvas";

export default function NotFound() {
  return (
    <PageState title="Page not found" tone="error" action={<Link href="/" className="text-accent hover:underline">Go to Chat</Link>}>
      There is nothing at this address.
    </PageState>
  );
}
