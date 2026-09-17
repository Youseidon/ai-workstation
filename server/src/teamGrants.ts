export const ITEM_GRANT_CAPABILITIES = ["context", "answer", "resume"] as const;

export type ItemGrantCapability = (typeof ITEM_GRANT_CAPABILITIES)[number];

export function isItemGrantCapability(value: unknown): value is ItemGrantCapability {
  return typeof value === "string" && ITEM_GRANT_CAPABILITIES.some(capability => capability === value);
}

export type ItemGrantOperation = "context" | "save_answer" | "answer_and_resume" | "resume_saved";

export function requiredItemGrantCapabilities(operation: ItemGrantOperation): ItemGrantCapability[] {
  switch (operation) {
    case "context": return ["context"];
    case "save_answer": return ["answer"];
    case "answer_and_resume": return ["answer", "resume"];
    case "resume_saved": return ["resume"];
  }
}

export interface ItemGrantEvaluation {
  allowed: boolean;
  missing: ItemGrantCapability[];
}

export function evaluateItemGrant(input: {
  actorPersonId: string;
  ownerPersonId: string;
  operation: ItemGrantOperation;
  activeCapabilities: Iterable<ItemGrantCapability>;
}): ItemGrantEvaluation {
  if (input.actorPersonId === input.ownerPersonId) return { allowed: true, missing: [] };
  const active = new Set(input.activeCapabilities);
  const missing = requiredItemGrantCapabilities(input.operation).filter(capability => !active.has(capability));
  return { allowed: missing.length === 0, missing };
}
