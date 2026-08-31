"use client";

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

/* --------------------------------------------------------------------------
   Every input in the app is labelled, describable and able to show an error.
   The old forms used bare placeholder-only inputs, which left screen readers
   with nothing and sighted users with no label once they had typed.
   -------------------------------------------------------------------------- */

interface FieldShellProps {
  id: string;
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  hintId: string;
  errorId: string;
  className?: string;
  children: ReactNode;
}

function FieldShell({
  id,
  label,
  hint,
  error,
  required,
  hintId,
  errorId,
  className,
  children,
}: FieldShellProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {label !== undefined && (
        <label htmlFor={id} className="text-xs font-medium text-fg-muted">
          {label}
          {required === true && (
            <span className="ml-1 text-danger" aria-hidden>
              *
            </span>
          )}
        </label>
      )}
      {children}
      {hint !== undefined && error == null && (
        <p id={hintId} className="text-[11px] leading-relaxed text-fg-dim">
          {hint}
        </p>
      )}
      {error != null && error !== "" && (
        <p id={errorId} role="alert" className="flex items-start gap-1.5 text-[11px] text-danger">
          <span aria-hidden>✗</span>
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/** Shared look for every text-like control. */
const CONTROL = [
  "w-full min-w-0 rounded-md bg-surface-2 px-3 text-[13px] text-fg",
  "ring-1 ring-inset ring-line transition-shadow duration-150",
  "placeholder:text-fg-dim",
  "hover:ring-line-strong",
  "focus:outline-none focus:ring-2 focus:ring-accent/70",
  "disabled:cursor-not-allowed disabled:opacity-50",
].join(" ");

const INVALID = "ring-danger/70 hover:ring-danger focus:ring-danger";

interface Common {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  fieldClassName?: string;
}

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">,
    Common {}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { label, hint, error, fieldClassName, className, id, required, ...rest },
  ref,
) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const invalid = error != null && error !== "";

  return (
    <FieldShell
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      required={required}
      hintId={hintId}
      errorId={errorId}
      className={fieldClassName}
    >
      <input
        ref={ref}
        id={fieldId}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : hint !== undefined ? hintId : undefined}
        className={cn(CONTROL, "h-9", invalid && INVALID, className)}
        {...rest}
      />
    </FieldShell>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, Common {}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, fieldClassName, className, id, required, rows = 4, ...rest },
  ref,
) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const invalid = error != null && error !== "";

  return (
    <FieldShell
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      required={required}
      hintId={hintId}
      errorId={errorId}
      className={fieldClassName}
    >
      <textarea
        ref={ref}
        id={fieldId}
        rows={rows}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : hint !== undefined ? hintId : undefined}
        className={cn(CONTROL, "resize-y py-2 leading-relaxed", invalid && INVALID, className)}
        {...rest}
      />
    </FieldShell>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, Common {}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, fieldClassName, className, id, required, children, ...rest },
  ref,
) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const invalid = error != null && error !== "";

  return (
    <FieldShell
      id={fieldId}
      label={label}
      hint={hint}
      error={error}
      required={required}
      hintId={hintId}
      errorId={errorId}
      className={fieldClassName}
    >
      <div className="relative">
        <select
          ref={ref}
          id={fieldId}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : hint !== undefined ? hintId : undefined}
          className={cn(CONTROL, "h-9 cursor-pointer appearance-none pr-8", invalid && INVALID, className)}
          {...rest}
        >
          {children}
        </select>
        <span
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-fg-dim"
        >
          ▼
        </span>
      </div>
    </FieldShell>
  );
});
