/**
 * A program an agent has proposed, and nothing has yet accepted.
 *
 * The shape here is deliberately the *same* tree the disk importer produces —
 * program, suites, work items, dependencies, gates — because the apply path is
 * the importer's transaction. What is different is where it lives: a draft is a
 * row in `program_draft`, read by nobody but the operator's preview, until a
 * human applies it. An agent authoring work items is exactly the case where
 * "the pipeline never infers an outcome" has to hold: it may write a proposal,
 * it may not write the library.
 *
 * Pure: no I/O and no database, so the validation an agent's post is refused by
 * is the same validation the preview screen runs, and both are testable on
 * their own.
 */

import { parseVerifyBlock } from "./verifyBlock";

export const PROGRAM_DRAFT_STATES = ["PENDING", "APPLIED", "DISCARDED"] as const;
export type ProgramDraftState = (typeof PROGRAM_DRAFT_STATES)[number];

export function isProgramDraftState(value: unknown): value is ProgramDraftState {
  return typeof value === "string" && (PROGRAM_DRAFT_STATES as readonly string[]).includes(value);
}

/*
 * Bounds. These are refusal thresholds, not style advice: a draft is posted by
 * a model in one or more HTTP calls, and an unbounded one is how a single run
 * writes a thousand work items nobody will ever read.
 */
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

/**
 * A revision copies a program that already exists, and the library was never
 * held to a new draft's caps — a work item may hold 64 KB, and an imported
 * program may have more suites than an agent would be allowed to propose. A
 * revision that refused to open on its own starting point would be useless, so
 * it is bounded by what the library itself accepts, and a little room past it.
 */
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
  /** Assigned by the server (`S1-01`), never by the agent — the keys are unique indexes. */
  key: string;
  title: string;
  content: string;
  /** Keys of other work items in this draft. Unknown keys are reported, not silently dropped. */
  dependsOn: string[];
  gate: ProgramDraftGate | null;
  /**
   * On a revision draft: the `prompt.id` this entry is a copy of. Absent or
   * null means a new work item. It is identity, not a hint — apply updates that
   * row in place, which is what keeps its status and run history attached.
   */
  sourceId?: number | null;
}

export interface ProgramDraftSuite {
  /** Assigned by the server (`S1`). */
  key: string;
  name: string;
  overview: string;
  prompts: ProgramDraftPrompt[];
  /** True once an agent has posted this suite's work items. */
  filled: boolean;
  /** On a revision draft: the `suite.id` this entry is a copy of. */
  sourceId?: number | null;
}

export interface ProgramDraftBody {
  name: string;
  overview: string;
  /** What the agent read to arrive at this shape. Kept for the operator, not applied. */
  notes: string;
  suites: ProgramDraftSuite[];
}

export interface ProgramDraftRecord {
  id: number;
  workspaceId: number;
  /** The author run that is filling it in, if one is. Provenance, not a foreign key. */
  runId: string | null;
  state: ProgramDraftState;
  goal: string;
  body: ProgramDraftBody;
  /** Set when the draft was applied: the program it became. */
  appliedProgramId: number | null;
  /**
   * Set on a revision draft: the existing program this draft changes. Null is
   * a proposal for a new program.
   */
  targetProgramId: number | null;
  /**
   * A revision draft's starting point: the program as it was when the draft
   * was opened. Apply compares against it, so only what the draft actually
   * changed is written, and an edit made to the program since is a conflict
   * rather than something silently overwritten.
   */
  baseline: ProgramDraftBody | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProgramDraftPreview {
  name: string;
  suites: number;
  /** Suites an agent has actually posted work items for. */
  filledSuites: number;
  prompts: number;
  dependencies: number;
  gates: number;
  /** Work items whose `## Verify` block will become command criteria on apply. */
  verifiable: number;
  /** Everything that would make an apply refuse, or that the operator should see first. */
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

/**
 * The opening post: what the program is, and what its suites are called.
 *
 * Work items are deliberately not accepted here. A model asked for a whole
 * program in one JSON body writes a long one and truncates it, and a truncated
 * body is a parse error that costs the run everything it had composed. Suites
 * first, then one post per suite, means a run that is stopped halfway leaves a
 * partial draft the next run continues rather than nothing at all.
 */
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

/** One suite's work items. `suite` may be the assigned key (`S2`) or the suite's name. */
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

/** The draft body a program proposal opens. Replaces any earlier proposal wholesale. */
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

/**
 * A suite's work items, folded in. Re-posting a suite replaces it rather than
 * appending: a run that is asked to revise S2 should be able to say what S2 is
 * now, not what to add to it.
 */
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

/** Dependencies that name a work item this draft actually has. */
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

/**
 * What is wrong with this draft, in the operator's words.
 *
 * Two classes are mixed on purpose and told apart by `blocksApply`: a suite
 * with no work items cannot be applied at all, while a dependency naming a key
 * that is not here is applied without that edge and has to be *seen*, because
 * silently dropping an ordering constraint is how a program runs in the wrong
 * order with nothing on screen to explain it.
 */
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

/** True when nothing in the draft stops it being applied. */
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

/**
 * An operator's edit of a draft body.
 *
 * The same bounds as the agent's post, and the same key assignment: the
 * operator may retitle, rewrite, reorder and delete, but keys are positional
 * and the server owns them, so an edit cannot introduce the duplicate that the
 * unique index would refuse hours later at apply time.
 *
 * A revision draft (`revision: true`) is the exception to positional keys.
 * Its keys name rows that already exist and that `dependsOn` points at, so
 * renumbering after a deletion would silently re-point every later
 * dependency. There a key is kept when it is well formed and not already used,
 * and only a missing or clashing one is assigned — the no-duplicates guarantee
 * is the same, reached without moving anything. `sourceId` is kept as given;
 * whether it really names a row of the target program is the server's check at
 * apply time, not something a client can assert here.
 */
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

/** What a revision draft's keys may look like: short, upper case, no spaces. */
export const DRAFT_KEY_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;

function sourceIdFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * A program key from the program's own name, unique within the workspace.
 *
 * Programs are addressed by key in the tree and in every prompt's context, so
 * one is assigned rather than asked for: a model choosing its own would collide
 * with an existing program's and the insert would fail at the end of a long
 * authoring run, which is the worst possible moment to find out.
 */
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
