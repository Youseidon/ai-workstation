import Link from "next/link";
import { PageState } from "@/components/shell/PageCanvas";

/** Unknown addresses stay inside the application shell. */
export default function NotFound() {
  return (
    <PageState title="Page not found" tone="error" action={<Link href="/" className="text-accent hover:underline">Go to Chat</Link>}>
      There is nothing at this address.
    </PageState>
  );
}
