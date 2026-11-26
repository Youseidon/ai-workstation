import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

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

export function ContentTitle({
  title,
  titleEditor,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  titleEditor?: ReactNode;
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
