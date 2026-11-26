import type { PromptStatus } from "./workspaces.ts";

export interface PromptImportPreview {
  programKey: string;
  programName: string;
  suites: number;
  prompts: number;
  dependencies: number;
  gates: number;
  statuses: Record<PromptStatus, number>;
  workspaceDescriptionCharacters: number;
  warnings: string[];
}
