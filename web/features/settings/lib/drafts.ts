import type { SettingField, SettingValue } from "@hydra/shared";

export type SettingDrafts = Record<string, SettingValue>;
export interface SettingsDraftState {
  drafts: SettingDrafts;
  setDrafts(update: (current: SettingDrafts) => SettingDrafts): void;
}

export function dirtySettings(
  fields: SettingField[],
  drafts: SettingDrafts,
): string[] {
  return fields
    .filter(
      (field) =>
        drafts[field.key] !== undefined && drafts[field.key] !== field.value,
    )
    .map((field) => field.key);
}

export function clearSubmittedDrafts(
  current: SettingDrafts,
  submitted: SettingDrafts,
): SettingDrafts {
  const next = { ...current };
  for (const [key, value] of Object.entries(submitted))
    if (next[key] === value) delete next[key];
  return next;
}

export function dangerousSetting(
  field: SettingField,
  value: SettingValue,
): boolean {
  return field.type === "boolean"
    ? value === true && field.dangerWhenTrue
    : field.options?.some(
        (option) => option.value === String(value) && option.danger,
      ) === true;
}
