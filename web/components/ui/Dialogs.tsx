"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./Button";
import { TextArea, TextInput } from "./Field";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  /**
   * Requires the user to type this exact string before confirming. Use it for
   * irreversible cascades — deleting a workspace takes its programs, suites and
   * prompts with it, which is too much to hang on a reflexive Enter.
   */
  confirmPhrase?: string;
}

export interface PromptOptions {
  title: ReactNode;
  description?: ReactNode;
  label: string;
  placeholder?: string;
  initialValue?: string;
  hint?: ReactNode;
  confirmLabel?: string;
  multiline?: boolean;
  /** Return an error message to block submission, or null to allow it. */
  validate?(value: string): string | null;
}

interface DialogsApi {
  /** Resolves true if confirmed, false if cancelled or dismissed. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Resolves the entered text, or null if cancelled. */
  prompt(options: PromptOptions): Promise<string | null>;
}

const DialogsContext = createContext<DialogsApi | null>(null);

type Request =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

/**
 * Promise-based replacements for `window.confirm` / `window.prompt`.
 *
 * The native ones cannot be themed, cannot be styled, freeze the tab, and give
 * no room for validation or a typed-phrase guard on destructive actions. These
 * read the same at the call site — `await dialogs.confirm({...})` — so adopting
 * them is a one-line change wherever the old ones were used.
 */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const [value, setValue] = useState("");
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Guards against a second resolve if the user hits Escape and the button
  // handler both fire for the same request.
  const settled = useRef(false);

  const open = useCallback((next: Request, initial: string) => {
    settled.current = false;
    setValue(initial);
    setPhrase("");
    setError(null);
    setRequest(next);
  }, []);

  const api = useMemo<DialogsApi>(
    () => ({
      confirm: (options) =>
        new Promise<boolean>((resolve) => open({ kind: "confirm", options, resolve }, "")),
      prompt: (options) =>
        new Promise<string | null>((resolve) =>
          open({ kind: "prompt", options, resolve }, options.initialValue ?? ""),
        ),
    }),
    [open],
  );

  const settle = useCallback(
    (outcome: boolean | string | null) => {
      if (request === null || settled.current) return;
      settled.current = true;
      if (request.kind === "confirm") request.resolve(outcome === true);
      else request.resolve(typeof outcome === "string" ? outcome : null);
      setRequest(null);
    },
    [request],
  );

  const cancel = useCallback(() => settle(request?.kind === "confirm" ? false : null), [
    request,
    settle,
  ]);

  const submitPrompt = useCallback(() => {
    if (request?.kind !== "prompt") return;
    const trimmed = value.trim();
    const message = request.options.validate?.(trimmed) ?? (trimmed === "" ? "This is required." : null);
    if (message !== null) {
      setError(message);
      return;
    }
    settle(trimmed);
  }, [request, settle, value]);

  const confirmOptions = request?.kind === "confirm" ? request.options : null;
  const promptOptions = request?.kind === "prompt" ? request.options : null;
  const phraseSatisfied =
    confirmOptions?.confirmPhrase === undefined || phrase.trim() === confirmOptions.confirmPhrase;

  return (
    <DialogsContext.Provider value={api}>
      {children}

      <Modal
        open={confirmOptions !== null}
        onClose={cancel}
        title={confirmOptions?.title ?? ""}
        description={confirmOptions?.description}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={cancel}>
              {confirmOptions?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={confirmOptions?.tone === "danger" ? "danger" : "primary"}
              disabled={!phraseSatisfied}
              onClick={() => settle(true)}
            >
              {confirmOptions?.confirmLabel ?? "Confirm"}
            </Button>
          </>
        }
      >
        {confirmOptions?.confirmPhrase !== undefined && (
          <TextInput
            label={
              <>
                Type <span className="font-semibold text-fg">{confirmOptions.confirmPhrase}</span> to
                confirm
              </>
            }
            value={phrase}
            autoComplete="off"
            onChange={(event) => setPhrase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && phraseSatisfied) settle(true);
            }}
          />
        )}
      </Modal>

      <Modal
        open={promptOptions !== null}
        onClose={cancel}
        title={promptOptions?.title ?? ""}
        description={promptOptions?.description}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitPrompt}>
              {promptOptions?.confirmLabel ?? "Save"}
            </Button>
          </>
        }
      >
        {promptOptions !== null &&
          (promptOptions.multiline === true ? (
            <TextArea
              label={promptOptions.label}
              hint={promptOptions.hint}
              placeholder={promptOptions.placeholder}
              error={error}
              rows={6}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
          ) : (
            <TextInput
              label={promptOptions.label}
              hint={promptOptions.hint}
              placeholder={promptOptions.placeholder}
              error={error}
              value={value}
              autoComplete="off"
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitPrompt();
                }
              }}
            />
          ))}
      </Modal>
    </DialogsContext.Provider>
  );
}

export function useDialogs(): DialogsApi {
  const context = useContext(DialogsContext);
  if (context === null) throw new Error("useDialogs must be used inside <DialogProvider>");
  return context;
}
