import { parseVerifyBlock } from "../utils/verifyBlock.ts";

export const PROGRAM_DRAFT_STATES = ["PENDING", "APPLIED", "DISCARDED"] as const;
export type ProgramDraftState = (typeof PROGRAM_DRAFT_STATES)[number];

export function isProgramDraftState(value: unknown): value is ProgramDraftState {
  return typeof value === "string" && (PROGRAM_DRAFT_STATES as readonly string[]).includes(value);
}

export const DRAFT_NAME_MAX = 120;
export const DRAFT_OVERVIEW_MAX = 10_000;
export const DRAFT_GOAL_MAX = 20_000;
export const DRAFT_NOTES_MAX = 20_000;
export const DRAFT_TITLE_MAX = 160;
export const DRAFT_CONTENT_MAX = 20_000;
export const DRAFT_MIN_SUITES = 1;
export const DRAFT_MAX_SUITES = 12;
export const DRAFT_MAX_PROMPTS_PER_SUITE = 40;
export const DRAFT_MAX_PROMPTS = 200;

export interface DraftLimits {
  contentMax: number;
  maxSuites: number;
  maxPromptsPerSuite: number;
  maxPrompts: number;
}

export function draftLimits(revision: boolean): DraftLimits {
  return revision
    ? { contentMax: 64_000, maxSuites: 100, maxPromptsPerSuite: 500, maxPrompts: 2_000 }
    : { contentMax: DRAFT_CONTENT_MAX, maxSuites: DRAFT_MAX_SUITES, maxPromptsPerSuite: DRAFT_MAX_PROMPTS_PER_SUITE, maxPrompts: DRAFT_MAX_PROMPTS };
}

export interface ProgramDraftGate {
  name: string;
  description: string;
}

export interface ProgramDraftPrompt {
  key: string;
  title: string;
  content: string;
  dependsOn: string[];
  gate: ProgramDraftGate | null;
  sourceId?: number | null;
}

export interface ProgramDraftSuite {
  key: string;
  name: string;
  overview: string;
  prompts: ProgramDraftPrompt[];
  filled: boolean;
  sourceId?: number | null;
}

export interface ProgramDraftBody {
  name: string;
  overview: string;
  notes: string;
  suites: ProgramDraftSuite[];
}

export interface ProgramDraftRecord {
  id: number;
  workspaceId: number;
  runId: string | null;
  state: ProgramDraftState;
  goal: string;
  body: ProgramDraftBody;
  appliedProgramId: number | null;
  targetProgramId: number | null;
  baseline: ProgramDraftBody | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProgramDraftPreview {
  name: string;
  suites: number;
  filledSuites: number;
  prompts: number;
  dependencies: number;
  gates: number;
  verifiable: number;
  issues: string[];
}

export type DraftValidation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Record<string, string> };

export interface ProgramProposal {
  name: string;
  overview: string;
  notes: string;
  suites: Array<{ name: string; overview: string }>;
}

export interface SuiteProposal {
  suiteKey: string;
  prompts: Array<{ title: string; content: string; dependsOn: string[]; gate: ProgramDraftGate | null }>;
}

export function emptyProgramDraftBody(): ProgramDraftBody {
  return { name: "", overview: "", notes: "", suites: [] };
}

export function suiteKeyAt(index: number): string {
  return `S${index + 1}`;
}

export function promptKeyAt(suiteKey: string, index: number): string {
  return `${suiteKey}-${String(index + 1).padStart(2, "0")}`;
}

function text(
  value: unknown,
  field: string,
  max: number,
  errors: Record<string, string>,
  { required = true }: { required?: boolean } = {},
): string {
  if (value === undefined || value === null) {
    if (required) errors[field] = "Required";
    return "";
  }
  if (typeof value !== "string") {
    errors[field] = "Must be text";
    return "";
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    if (required) errors[field] = "Required";
    return "";
  }
  if (trimmed.length > max) {
    errors[field] = `Must be under ${max} characters`;
    return trimmed.slice(0, max);
  }
  return trimmed;
}

export function normalizeProgramProposal(input: unknown): DraftValidation<ProgramProposal> {
  const errors: Record<string, string> = {};
  const raw = (input ?? {}) as Record<string, unknown>;
  const name = text(raw.name, "name", DRAFT_NAME_MAX, errors);
  const overview = text(raw.overview, "overview", DRAFT_OVERVIEW_MAX, errors, { required: false });
  const notes = text(raw.notes, "notes", DRAFT_NOTES_MAX, errors, { required: false });
  const rawSuites = Array.isArray(raw.suites) ? raw.suites : null;
  const suites: Array<{ name: string; overview: string }> = [];
  if (rawSuites === null) {
    errors.suites = "Must be an array of suites";
  } else if (rawSuites.length < DRAFT_MIN_SUITES || rawSuites.length > DRAFT_MAX_SUITES) {
    errors.suites = `Must list between ${DRAFT_MIN_SUITES} and ${DRAFT_MAX_SUITES} suites`;
  } else {
    const seen = new Set<string>();
    rawSuites.forEach((entry, index) => {
      const suite = (typeof entry === "string" ? { name: entry } : entry ?? {}) as Record<string, unknown>;
      const suiteName = text(suite.name, `suites[${index}].name`, DRAFT_NAME_MAX, errors);
      const key = suiteName.toLowerCase();
      if (suiteName !== "" && seen.has(key)) errors[`suites[${index}].name`] = "Two suites cannot share a name";
      seen.add(key);
      suites.push({
        name: suiteName,
        overview: text(suite.overview, `suites[${index}].overview`, DRAFT_OVERVIEW_MAX, errors, { required: false }),
      });
    });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, overview, notes, suites } };
}

export function normalizeSuiteProposal(input: unknown, body: ProgramDraftBody): DraftValidation<SuiteProposal> {
  const errors: Record<string, string> = {};
  const raw = (input ?? {}) as Record<string, unknown>;
  const wanted = typeof raw.suite === "string" ? raw.suite.trim().toLowerCase() : "";
  const suite = body.suites.find(
    (entry) => entry.key.toLowerCase() === wanted || entry.name.toLowerCase() === wanted,
  );
  if (wanted === "") errors.suite = "Required";
  else if (suite === undefined) {
    errors.suite = `No suite called "${String(raw.suite)}" in this draft. Known: ${body.suites.map((entry) => `${entry.key} (${entry.name})`).join(", ")}`;
  }
  const rawPrompts = Array.isArray(raw.prompts) ? raw.prompts : null;
  const prompts: SuiteProposal["prompts"] = [];
  if (rawPrompts === null) {
    errors.prompts = "Must be an array of work items";
  } else if (rawPrompts.length === 0 || rawPrompts.length > DRAFT_MAX_PROMPTS_PER_SUITE) {
    errors.prompts = `Must list between 1 and ${DRAFT_MAX_PROMPTS_PER_SUITE} work items`;
  } else {
    const seen = new Set<string>();
    rawPrompts.forEach((entry, index) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const title = text(item.title, `prompts[${index}].title`, DRAFT_TITLE_MAX, errors);
      if (title !== "" && seen.has(title.toLowerCase())) {
        errors[`prompts[${index}].title`] = "Two work items in a suite cannot share a title";
      }
      seen.add(title.toLowerCase());
      const content = text(item.content, `prompts[${index}].content`, DRAFT_CONTENT_MAX, errors);
      const dependsOn = Array.isArray(item.dependsOn)
        ? item.dependsOn.filter((value): value is string => typeof value === "string").map((value) => value.trim().toUpperCase()).filter((value) => value !== "")
        : [];
      const rawGate = (item.gate ?? null) as Record<string, unknown> | null;
      const gate = rawGate === null || typeof rawGate !== "object"
        ? null
        : {
            name: text(rawGate.name, `prompts[${index}].gate.name`, DRAFT_NAME_MAX, errors),
            description: text(rawGate.description, `prompts[${index}].gate.description`, DRAFT_OVERVIEW_MAX, errors, { required: false }),
          };
      prompts.push({ title, content, dependsOn, gate });
    });
  }
  const already = countPrompts(body) - (suite?.prompts.length ?? 0);
  if (already + prompts.length > DRAFT_MAX_PROMPTS) {
    errors.prompts = `This draft would exceed ${DRAFT_MAX_PROMPTS} work items`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { suiteKey: suite!.key, prompts } };
}

export function bodyFromProgramProposal(proposal: ProgramProposal): ProgramDraftBody {
  return {
    name: proposal.name,
    overview: proposal.overview,
    notes: proposal.notes,
    suites: proposal.suites.map((suite, index) => ({
      key: suiteKeyAt(index),
      name: suite.name,
      overview: suite.overview,
      prompts: [],
      filled: false,
    })),
  };
}

export function withSuiteProposal(body: ProgramDraftBody, proposal: SuiteProposal): ProgramDraftBody {
  return {
    ...body,
    suites: body.suites.map((suite) =>
      suite.key !== proposal.suiteKey
        ? suite
        : {
            ...suite,
            filled: true,
            prompts: proposal.prompts.map((prompt, index) => ({
              key: promptKeyAt(suite.key, index),
              title: prompt.title,
              content: prompt.content,
              dependsOn: prompt.dependsOn,
              gate: prompt.gate,
            })),
          },
    ),
  };
}

export function countPrompts(body: ProgramDraftBody): number {
  return body.suites.reduce((total, suite) => total + suite.prompts.length, 0);
}

export function allPrompts(body: ProgramDraftBody): Array<{ suite: ProgramDraftSuite; prompt: ProgramDraftPrompt }> {
  return body.suites.flatMap((suite) => suite.prompts.map((prompt) => ({ suite, prompt })));
}

export function resolvedDependencies(body: ProgramDraftBody): Array<{ promptKey: string; dependsOnKey: string }> {
  const known = new Set(allPrompts(body).map((entry) => entry.prompt.key));
  const edges: Array<{ promptKey: string; dependsOnKey: string }> = [];
  for (const { prompt } of allPrompts(body)) {
    for (const dependsOnKey of prompt.dependsOn) {
      if (dependsOnKey !== prompt.key && known.has(dependsOnKey)) edges.push({ promptKey: prompt.key, dependsOnKey });
    }
  }
  return edges;
}

export function programDraftIssues(body: ProgramDraftBody): string[] {
  const issues: string[] = [];
  if (body.name.trim() === "") issues.push("The program has no name.");
  if (body.suites.length === 0) issues.push("The program has no suites.");
  const known = new Set(allPrompts(body).map((entry) => entry.prompt.key));
  for (const suite of body.suites) {
    if (suite.prompts.length === 0) issues.push(`${suite.key} (${suite.name}) has no work items yet.`);
    const titles = new Set<string>();
    for (const prompt of suite.prompts) {
      const title = prompt.title.trim().toLowerCase();
      if (title !== "" && titles.has(title)) issues.push(`${suite.key} has two work items titled "${prompt.title}".`);
      titles.add(title);
    }
    for (const prompt of suite.prompts) {
      if (prompt.content.trim() === "") issues.push(`${prompt.key} has no instructions.`);
      for (const dependsOnKey of prompt.dependsOn) {
        if (dependsOnKey === prompt.key) issues.push(`${prompt.key} depends on itself; that edge will be dropped.`);
        else if (!known.has(dependsOnKey)) issues.push(`${prompt.key} depends on ${dependsOnKey}, which is not in this draft; that edge will be dropped.`);
      }
    }
  }
  return issues;
}

export function canApplyProgramDraft(body: ProgramDraftBody): boolean {
  return (
    body.name.trim() !== "" &&
    body.suites.length > 0 &&
    body.suites.every((suite) => suite.prompts.length > 0) &&
    body.suites.every((suite) => new Set(suite.prompts.map((prompt) => prompt.title.trim().toLowerCase())).size === suite.prompts.length) &&
    allPrompts(body).every((entry) => entry.prompt.title.trim() !== "" && entry.prompt.content.trim() !== "")
  );
}

export function programDraftPreview(body: ProgramDraftBody): ProgramDraftPreview {
  const prompts = allPrompts(body);
  return {
    name: body.name,
    suites: body.suites.length,
    filledSuites: body.suites.filter((suite) => suite.prompts.length > 0).length,
    prompts: prompts.length,
    dependencies: resolvedDependencies(body).length,
    gates: prompts.filter((entry) => entry.prompt.gate !== null).length,
    verifiable: prompts.filter((entry) => parseVerifyBlock(entry.prompt.content).commands.length > 0).length,
    issues: programDraftIssues(body),
  };
}

export function normalizeProgramDraftBody(
  input: unknown,
  options: { revision?: boolean } = {},
): DraftValidation<ProgramDraftBody> {
  const revision = options.revision === true;
  const limits = draftLimits(revision);
  const errors: Record<string, string> = {};
  const raw = (input ?? {}) as Record<string, unknown>;
  const name = text(raw.name, "name", DRAFT_NAME_MAX, errors);
  const overview = text(raw.overview, "overview", DRAFT_OVERVIEW_MAX, errors, { required: false });
  const notes = text(raw.notes, "notes", DRAFT_NOTES_MAX, errors, { required: false });
  const rawSuites = Array.isArray(raw.suites) ? raw.suites : null;
  const suites: ProgramDraftSuite[] = [];
  const suiteKeys = new Set<string>();
  const promptKeys = new Set<string>();
  const claim = (wanted: unknown, used: Set<string>, fallback: (n: number) => string): string => {
    const candidate = typeof wanted === "string" ? wanted.trim().toUpperCase() : "";
    if (revision && DRAFT_KEY_PATTERN.test(candidate) && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    for (let n = 0; ; n += 1) {
      const next = fallback(n);
      if (!used.has(next)) {
        used.add(next);
        return next;
      }
    }
  };
  if (rawSuites === null) errors.suites = "Must be an array of suites";
  else if (rawSuites.length > limits.maxSuites) errors.suites = `Must list at most ${limits.maxSuites} suites`;
  else {
    let total = 0;
    rawSuites.forEach((entry, index) => {
      const suite = (entry ?? {}) as Record<string, unknown>;
      const key = revision ? claim(suite.key, suiteKeys, (n) => suiteKeyAt(index + n)) : suiteKeyAt(index);
      const rawPrompts = Array.isArray(suite.prompts) ? suite.prompts : [];
      if (rawPrompts.length > limits.maxPromptsPerSuite) {
        errors[`suites[${index}].prompts`] = `Must list at most ${limits.maxPromptsPerSuite} work items`;
      }
      total += rawPrompts.length;
      suites.push({
        key,
        name: text(suite.name, `suites[${index}].name`, DRAFT_NAME_MAX, errors),
        overview: text(suite.overview, `suites[${index}].overview`, DRAFT_OVERVIEW_MAX, errors, { required: false }),
        filled: rawPrompts.length > 0,
        ...(revision ? { sourceId: sourceIdFrom(suite.sourceId) } : {}),
        prompts: rawPrompts.map((promptEntry, promptIndex) => {
          const prompt = (promptEntry ?? {}) as Record<string, unknown>;
          const rawGate = (prompt.gate ?? null) as Record<string, unknown> | null;
          return {
            key: revision
              ? claim(prompt.key, promptKeys, (n) => promptKeyAt(key, promptIndex + n))
              : promptKeyAt(key, promptIndex),
            title: text(prompt.title, `suites[${index}].prompts[${promptIndex}].title`, DRAFT_TITLE_MAX, errors),
            content: text(prompt.content, `suites[${index}].prompts[${promptIndex}].content`, limits.contentMax, errors),
            dependsOn: Array.isArray(prompt.dependsOn)
              ? prompt.dependsOn.filter((value): value is string => typeof value === "string").map((value) => value.trim().toUpperCase())
              : [],
            gate: rawGate === null || typeof rawGate !== "object"
              ? null
              : {
                  name: text(rawGate.name, `suites[${index}].prompts[${promptIndex}].gate.name`, DRAFT_NAME_MAX, errors),
                  description: text(rawGate.description, `suites[${index}].prompts[${promptIndex}].gate.description`, DRAFT_OVERVIEW_MAX, errors, { required: false }),
                },
            ...(revision ? { sourceId: sourceIdFrom(prompt.sourceId) } : {}),
          };
        }),
      });
    });
    if (total > limits.maxPrompts) errors.suites = `A draft may hold at most ${limits.maxPrompts} work items`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, overview, notes, suites } };
}

export const DRAFT_KEY_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;

function sourceIdFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function programKeyFrom(name: string, taken: Iterable<string>): string {
  const held = new Set([...taken].map((key) => key.toUpperCase()));
  const words = name.toUpperCase().split(/[^A-Z0-9]+/).filter((word) => word !== "");
  const base = (words.length >= 2 ? words.map((word) => word[0]!).join("") : words[0] ?? "PROGRAM").slice(0, 12);
  const candidate = base === "" ? "PROGRAM" : base;
  if (!held.has(candidate)) return candidate;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const next = `${candidate.slice(0, 9)}${suffix}`;
    if (!held.has(next)) return next;
  }
  return `${candidate.slice(0, 8)}${Date.now().toString(36).slice(-4).toUpperCase()}`;
}
