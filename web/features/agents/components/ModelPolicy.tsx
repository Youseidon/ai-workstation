"use client";

import {
  MODEL_ACCESS_TIERS,
  MODEL_ACCESS_TIER_INFO,
  REASONING_EFFORTS,
  type ModelAccessTier,
  type ModelSelectionMode,
  type ReasoningEffort,
} from "@hydra/shared";
import { ChoiceControl } from "@/features/settings/components/ChoiceControl";
import styles from "./configuration.module.css";

export function ModelPolicy({
  tier,
  mode,
  effort,
  disabled,
  loading,
  onTier,
  onMode,
  onEffort,
}: {
  tier: ModelAccessTier;
  mode: ModelSelectionMode;
  effort: ReasoningEffort;
  disabled: boolean;
  loading: boolean;
  onTier(tier: ModelAccessTier): void;
  onMode(mode: ModelSelectionMode): void;
  onEffort(effort: ReasoningEffort): void;
}) {
  if (loading)
    return (
      <section
        id="agents-model-access"
        className={styles.policy}
        aria-label="Model policy"
      >
        <p className="py-3 text-xs text-fg-muted" role="status">
          Waiting for saved model policy…
        </p>
      </section>
    );
  return (
    <section
      id="agents-model-access"
      className={styles.policy}
      aria-labelledby="model-policy-title"
    >
      <div className={styles.sectionHeading}>
        <h2 id="model-policy-title">Model policy</h2>
        <span>Account-wide · new runs · saves immediately</span>
      </div>
      <div className={styles.policyControls}>
        <div>
          <span id="model-choice-label" className={styles.label}>
            Model choice
          </span>
          <ChoiceControl
            labelledBy="model-choice-label"
            value={mode}
            options={[
              {
                value: "auto",
                label: "Auto Select",
                hint: null,
                danger: false,
              },
              { value: "manual", label: "Manual", hint: null, danger: false },
            ]}
            disabled={disabled}
            onChange={(value) => onMode(value as ModelSelectionMode)}
          />
        </div>
        <label className={styles.tierControl}>
          <span className={styles.label}>Access tier</span>
          <select
            aria-label="Access tier"
            aria-describedby="tier-hint"
            value={tier}
            disabled={disabled}
            onChange={(event) => onTier(event.target.value as ModelAccessTier)}
          >
            {MODEL_ACCESS_TIERS.map((value) => (
              <option key={value} value={value}>
                {MODEL_ACCESS_TIER_INFO[value].label} ·{" "}
                {MODEL_ACCESS_TIER_INFO[value].creditUse}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span id="global-effort-label" className={styles.label}>
            Reasoning effort
          </span>
          <ChoiceControl
            labelledBy="global-effort-label"
            value={effort}
            options={REASONING_EFFORTS.map((value) => ({
              value,
              label: value[0]?.toUpperCase() + value.slice(1),
              hint: null,
              danger: false,
            }))}
            disabled={disabled}
            onChange={(value) => onEffort(value as ReasoningEffort)}
          />
        </div>
      </div>
      <div className={styles.policyFoot}>
        <p id="tier-hint">
          {mode === "auto"
            ? "Server selects within this tier. Manual choices stay saved and inactive."
            : "Allowed browser choice → saved provider default → tier fallback."}
        </p>
        <details>
          <summary>Policy &amp; tier guide</summary>
          <div className={styles.policyGuide}>
            <p>
              Applies to every new console, task, pipeline, fallback, handoff
              and reviewer run. Existing runs continue with their current
              settings.
            </p>
            <dl>
              {MODEL_ACCESS_TIERS.map((value) => (
                <div key={value} data-active={value === tier}>
                  <dt>
                    {MODEL_ACCESS_TIER_INFO[value].label}
                    <small>{MODEL_ACCESS_TIER_INFO[value].creditUse}</small>
                  </dt>
                  <dd>{MODEL_ACCESS_TIER_INFO[value].description}</dd>
                </div>
              ))}
            </dl>
            <p>
              Higher tiers include lower tiers. Custom IDs require All models.
              Saved choices outside the tier remain preserved but inactive.
            </p>
            <p>
              Provider reasoning overrides take precedence over the global
              effort. Cursor’s model list follows its effective effort.
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}
