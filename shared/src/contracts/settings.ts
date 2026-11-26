/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export type SettingType = "string" | "password" | "boolean" | "number" | "select" | "path";

export type SettingValue = string | number | boolean;

export interface SettingOption {
  value: string;
  label: string;
  hint: string | null;
  /** Loosens a sandbox or permission check; rendered with a warning. */
  danger: boolean;
}

/** What a numeric setting measures, so every surface words it the same way. */
export type SettingUnit = "usd" | "minutes" | "ms" | "days" | "bytes" | "count";

/**
 * How a numeric setting is offered: a short ladder of sensible values instead
 * of a bare number box. Any other value is still legal — the ladder is a
 * presentation, not a validation rule.
 */
export interface SettingScale {
  unit: SettingUnit;
  /** Ascending. A 0 here is the "no limit" stop and is listed last. */
  stops: number[];
  /** What 0 means for this field, when 0 is meaningful. */
  zeroLabel: string | null;
  /** Singular noun for a `count`, e.g. "call". */
  noun: string | null;
}

export interface SettingField {
  key: string;
  label: string;
  group: string;
  type: SettingType;
  description: string;
  /** The environment variable this field mirrors, shown for reference. */
  envVar: string;
  placeholder: string | null;
  options: SettingOption[] | null;
  /** Value from .env / built-in fallback, before any saved override. */
  defaultValue: SettingValue;
  /** Effective value. Always "" for `password` fields — secrets never leave the server. */
  value: SettingValue;
  /** True when a saved override differs from `defaultValue`. */
  overridden: boolean;
  /** For `password` fields: whether a value is currently set. */
  isSet: boolean;
  /** True when the current value loosens a sandbox or permission check. */
  danger: boolean;
  /**
   * For boolean fields: the `true` value is the dangerous one. The client uses
   * this to warn on unsaved drafts, because `danger` only reflects the saved value.
   */
  dangerWhenTrue: boolean;
  /** Changing this only takes effect after a server restart. */
  requiresRestart: boolean;
  /** For `number` fields offered as a ladder of values; null for a free number. */
  scale: SettingScale | null;
}

export interface SettingsSnapshot {
  fields: SettingField[];
  /** Group names in display order. */
  groups: string[];
  /** Where overrides are persisted on the server. */
  storagePath: string;
}

/** Patch sent to `PUT /api/settings`. Omitted keys are left unchanged. */
export type SettingsPatch = Record<string, SettingValue>;
