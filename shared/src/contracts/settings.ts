export type SettingType = "string" | "password" | "boolean" | "number" | "select" | "path";

export type SettingValue = string | number | boolean;

export interface SettingOption {
  value: string;
  label: string;
  hint: string | null;
  danger: boolean;
}

export type SettingUnit = "usd" | "minutes" | "ms" | "days" | "bytes" | "count";

export interface SettingScale {
  unit: SettingUnit;
  stops: number[];
  zeroLabel: string | null;
  noun: string | null;
}

export interface SettingField {
  key: string;
  label: string;
  group: string;
  type: SettingType;
  description: string;
  envVar: string;
  placeholder: string | null;
  options: SettingOption[] | null;
  defaultValue: SettingValue;
  value: SettingValue;
  overridden: boolean;
  isSet: boolean;
  danger: boolean;
  dangerWhenTrue: boolean;
  requiresRestart: boolean;
  scale: SettingScale | null;
}

export interface SettingsSnapshot {
  fields: SettingField[];
  groups: string[];
  storagePath: string;
}

export type SettingsPatch = Record<string, SettingValue>;
