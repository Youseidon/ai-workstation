"use client";

import { useState } from "react";
import type { ProviderInfo, SettingField } from "@hydra/shared";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { SettingRow } from "@/features/settings/components/SettingField";
import { useSettings } from "@/features/settings/hooks/useSettings";
import {
  clearSubmittedDrafts,
  type SettingsDraftState,
} from "@/features/settings/lib/drafts";
import { apiFetch } from "@/api/http";
import { SERVER_URL } from "@/api/serverUrl";
import type { ProviderSetupSession } from "../hooks/useProviderSetup";
import styles from "./configuration.module.css";

export function ProviderSetupDialog({
  provider,
  session,
  canInstall,
  connected,
  draftState,
  onInstall,
  onRetry,
  onCheck,
  onConfigure,
  onClose,
}: {
  provider: ProviderInfo;
  session: ProviderSetupSession | undefined;
  canInstall: boolean;
  connected: boolean;
  draftState: SettingsDraftState;
  onInstall(): void;
  onRetry(): void;
  onCheck(): Promise<void>;
  onConfigure(): void;
  onClose(): void;
}) {
  const settings = useSettings(SERVER_URL);
  const [checking, setChecking] = useState(false);
  const [verification, setVerification] = useState<ProviderInfo | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(
    null,
  );
  const checked = verification !== null;
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const info = session?.info;
  const installing = session?.state === "installing";
  const installed = info?.installed === true;
  const credential: SettingField | undefined = settings.snapshot?.fields.find(
    (field) => field.key === info?.credentialKey && field.type === "password",
  );
  const credentialDraft =
    credential === undefined ? undefined : draftState.drafts[credential.key];
  const saveCredential = async () => {
    if (!credential || credentialDraft === undefined) return;
    const patch = { [credential.key]: credentialDraft };
    const result = await settings.save(patch);
    if (!result.ok) return;
    draftState.setDrafts((current) => clearSubmittedDrafts(current, patch));
    setFeedback("Credential saved. Its value stays on the server.");
    await onCheck();
  };
  const check = async () => {
    setChecking(true);
    setVerification(null);
    setVerificationError(null);
    try {
      const response = await apiFetch(
        new URL("/api/providers?refresh=1", SERVER_URL),
        { cache: "no-store" },
      );
      if (!response.ok)
        throw new Error(
          `Provider detection failed (${response.status}). Try again.`,
        );
      const body = (await response.json()) as { providers: ProviderInfo[] };
      const detected = body.providers.find((entry) => entry.id === provider.id);
      if (!detected)
        throw new Error(
          "Provider detection did not return this provider. Try again.",
        );
      setVerification(detected);
      await onCheck();
    } catch (cause) {
      setVerificationError(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setChecking(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Set up ${provider.label}`}
      size="md"
      description="Install, connect your account, then verify readiness."
      footer={
        <Button variant="ghost" onClick={onClose}>
          {installing ? "Close · installation continues" : "Done"}
        </Button>
      }
    >
      <ol className={styles.setupSteps} aria-label="Setup progress">
        <li data-active={!installed}>1 · Install</li>
        <li data-active={installed && !checked}>2 · Connect</li>
        <li data-active={checked}>3 · Verify</li>
      </ol>
      {!connected && (
        <p className={styles.warning} role="alert">
          Reconnect to the backend before installing or saving credentials.
        </p>
      )}
      {!canInstall && (
        <p className={styles.warning}>
          Only the installation owner can install or update shared executables.
          You can still follow the connection instructions.
        </p>
      )}
      {(!session || session.state === "loading") && (
        <p role="status" className="text-sm text-fg-muted">
          Checking this machine’s installation…
        </p>
      )}
      {session?.error && (
        <div className={styles.error} role="alert">
          {session.error}
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Check setup again
          </Button>
        </div>
      )}
      {info && (
        <div className={styles.setupBody}>
          <section>
            <h3>
              {installed
                ? "Installed on the Hydra machine"
                : "Install on the Hydra machine"}
            </h3>
            <p>
              This runs on the computer hosting Hydra, under its OS user.
              Provider binaries and CLI logins are shared across Hydra accounts.
            </p>
            <div className={styles.setupSource}>
              <span>Source</span>
              <strong>{info.source}</strong>
              <a
                href={info.documentationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Official installation guide ↗
              </a>
            </div>
            {!installed && (
              <>
                <p>
                  Downloads the provider’s current release. Native installers
                  may add their command to your shell’s PATH.
                </p>
                {info.reason && <p className="text-warning">{info.reason}</p>}
                <Button
                  variant="primary"
                  loading={installing}
                  disabled={
                    !connected || !canInstall || !info.canInstall || installing
                  }
                  onClick={onInstall}
                >
                  {installing
                    ? "Downloading & installing…"
                    : `Install ${provider.transport === "sdk" ? "SDK" : "CLI"} on this machine`}
                </Button>
                {installing && (
                  <p role="status">
                    Installation is running on the server and may take a few
                    minutes. You can close this dialog; the row keeps its
                    progress.
                  </p>
                )}
              </>
            )}
          </section>
          {installed && (
            <>
              <section>
                <h3>Connect your account</h3>
                <p>{info.authNote}</p>
                <div className={styles.setupLogin}>
                  <code>{info.loginCommand}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(info.loginCommand)
                        .then(
                          () => setCopied(true),
                          () =>
                            setFeedback(
                              "Clipboard unavailable. Select and copy the command above.",
                            ),
                        );
                    }}
                  >
                    {copied ? "Copied" : "Copy login command"}
                  </Button>
                </div>
                <a
                  className={styles.textLink}
                  href={info.accountUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open provider account / keys ↗
                </a>
                {credential && (
                  <div className="mt-3">
                    <SettingRow
                      field={{ ...credential, overridden: false }}
                      draft={credentialDraft}
                      disabled={!connected || settings.saving}
                      onChange={(key, value) =>
                        draftState.setDrafts((current) => ({
                          ...current,
                          [key]: value,
                        }))
                      }
                      onRevert={() => {}}
                    />
                    {credentialDraft !== undefined &&
                      credentialDraft !== credential.value && (
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="success"
                            loading={settings.saving}
                            disabled={!connected}
                            onClick={() => void saveCredential()}
                          >
                            Save credential
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={settings.saving}
                            onClick={() =>
                              draftState.setDrafts((current) =>
                                clearSubmittedDrafts(current, {
                                  [credential.key]: credentialDraft,
                                }),
                              )
                            }
                          >
                            Discard edit
                          </Button>
                        </div>
                      )}
                  </div>
                )}
                {settings.errors.length > 0 && (
                  <p className={styles.error} role="alert">
                    {settings.errors.join(" · ")}
                  </p>
                )}
                <button
                  type="button"
                  className={styles.textLink}
                  onClick={onConfigure}
                >
                  Open provider settings →
                </button>
              </section>
              <section>
                <h3>Verify readiness</h3>
                <p>
                  After completing the CLI login or saving a key, check the
                  server’s detection. Installing does not enable a disabled
                  provider or change your model policy.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={checking}
                  disabled={!connected || checking}
                  onClick={() => void check()}
                >
                  Check connection
                </Button>
                {verificationError && (
                  <p className={styles.error} role="alert">
                    {verificationError}
                  </p>
                )}
                {checked && (
                  <p
                    role="status"
                    className={
                      verification?.available ? "text-success" : "text-warning"
                    }
                  >
                    {verification?.available
                      ? `${provider.label} is ready for new runs.`
                      : (verification?.reason ??
                        "Installed, but not ready. Check your credentials, enabled switch and model access tier.")}
                  </p>
                )}
              </section>
            </>
          )}
          {feedback && (
            <p role="status" className="text-xs text-fg-muted">
              {feedback}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
