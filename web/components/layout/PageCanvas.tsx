import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The shared content canvas. The shell owns the `main` landmark; routes render
 * a canvas inside it. `reading` keeps Chat's 880 px measure; `wide` lets dense
 * tables and diagrams use the available width. The canvas is the route's one
 * vertical scroll owner unless `scroll` is false (the route manages panes).
 */
export function PageCanvas({
  children,
  width = "wide",
  scroll = true,
  className,
}: {
  children: ReactNode;
  width?: "reading" | "wide";
  scroll?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("page-canvas", scroll && "page-canvas-scroll", className)} data-width={width}>
      {children}
    </div>
  );
}

/**
 * The content-level title and action group. It sits in the document flow
 * beside the content it describes; it is not a header bar.
 */
export function ContentTitle({
  title,
  titleEditor,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  /** An editable title (e.g. a name input). The heading stays for assistive tech. */
  titleEditor?: ReactNode;
  /** A back link or a quiet line of context above the title. */
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("content-title", className)}>
      <div className="min-w-0 flex-1">
        {meta !== undefined && meta !== null && <div className="content-title-meta">{meta}</div>}
        {titleEditor === undefined ? (
          <h1 className="content-title-heading">{title}</h1>
        ) : (
          <>
            <h1 className="sr-only">{title}</h1>
            {titleEditor}
          </>
        )}
      </div>
      {actions !== undefined && actions !== null && <div className="content-title-actions">{actions}</div>}
    </div>
  );
}

/**
 * Loading, empty, missing-record and error states for a whole page: the same
 * title placement and type as any other page, with the message in the flow.
 */
export function PageState({
  title,
  tone = "info",
  children,
  action,
}: {
  title: ReactNode;
  tone?: "info" | "loading" | "error";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-canvas page-canvas-scroll">
      <ContentTitle title={title} />
      <div className="page-state" role={tone === "error" ? "alert" : "status"} data-tone={tone}>
        <p>{children}</p>
        {action !== undefined && action !== null && <div className="page-state-action">{action}</div>}
      </div>
    </div>
  );
}
