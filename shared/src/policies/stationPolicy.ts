/** Capabilities belong to the station, independently of provider and model. */
export interface StationPolicy {
  version: 1;
  editFiles: boolean;
  build: boolean;
  generateContracts: boolean;
  verification: "allowed" | "deferred";
  verifier: string | null;
}

export function validateStationPolicy(value: unknown): StationPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stationPolicy must be an object");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !["version", "editFiles", "build", "generateContracts", "verification", "verifier"].includes(key))
    || p.version !== 1 || typeof p.editFiles !== "boolean" || typeof p.build !== "boolean"
    || typeof p.generateContracts !== "boolean" || !["allowed", "deferred"].includes(String(p.verification))
    || !(p.verifier === null || (typeof p.verifier === "string" && /^[\w.-]{1,80}$/.test(p.verifier)))) {
    throw new Error("Invalid stationPolicy capabilities");
  }
  return { version: 1, editFiles: p.editFiles, build: p.build, generateContracts: p.generateContracts,
    verification: p.verification as StationPolicy["verification"], verifier: p.verifier as string | null };
}

/** Narrow compatibility bridge for existing stations; explicit capabilities win. */
export function resolveStationPolicy(content: string, explicit?: StationPolicy | null): StationPolicy {
  if (explicit) return validateStationPolicy(explicit);
  const deferred = /\bNo verification execution in this station\b/i.test(content);
  return { version: 1, editFiles: true, build: true, generateContracts: true,
    verification: deferred ? "deferred" : "allowed",
    verifier: deferred ? content.match(/\bCompletion evidence goes to ([\w.-]+)/i)?.[1]?.replace(/\.$/, "") ?? null : null };
}

export function stationPolicyMarkdown(policy: StationPolicy): string {
  const destination = policy.verifier ?? "the suite's Verify station";
  return `## Station capabilities\n\nThese capabilities govern this station and override general testing guidance.\n`
    + `File edits: ${policy.editFiles ? "allowed" : "forbidden"}. Builds: ${policy.build ? "allowed" : "forbidden"}. Contract generation: ${policy.generateContracts ? "allowed" : "forbidden"}.\n`
    + (policy.verification === "deferred"
      ? `Test and verification execution: forbidden. ${destination} owns those checks. Author scenarios without executing them. Finish with changed paths, scenarios authored, fixture entries, exact pending commands and the handoff destination. Do not run checks to satisfy generic completion instructions.\n\n`
      : "Test and verification execution: allowed within the work item's scope. Report observable results honestly.\n\n");
}
