/**
 * Changing a program that already exists.
 *
 * A revision is a program draft with a target: it opens as a copy of the
 * program (every suite and work item carrying the `sourceId` of the row it
 * copies), an agent or the operator edits the copy, and apply writes back only
 * what differs from the copy's starting point. Nothing here touches the
 * library; this module is the pure half — the edit operations an agent posts,
 * and the list of changes the operator reads before applying.
 *
 * Why operations instead of re-posting suites: "add `npm run lint` to every
 * Verify block" is one `replace-text`, not two hundred work items retyped by a
 * model, and a work item that is not mentioned is not rewritten — so it cannot
 * drift by a character on the way through.
 */

import {
  DRAFT_NAME_MAX,
  DRAFT_NOTES_MAX,
  DRAFT_OVERVIEW_MAX,
  DRAFT_TITLE_MAX,
  draftLimits,
  normalizeProgramDraftBody,
  suiteKeyAt,
  type DraftValidation,
  type ProgramDraftBody,
  type ProgramDraftGate,
  type ProgramDraftPrompt,
  type ProgramDraftSuite,
} from "./programDraft";

/** One post's worth. A revision bigger than this is several posts. */
export const REVISION_MAX_CHANGES = 400;

export const REVISION_OPERATIONS = [
  "update-program",
  "add-suite",
  "update-suite",
  "move-suite",
  "remove-suite",
  "add-item",
  "update-item",
  "move-item",
  "remove-item",
  "replace-text",
] as const;
export type RevisionOperation = (typeof REVISION_OPERATIONS)[number];

export interface RevisionResult {
  body: ProgramDraftBody;
  /** One line per change, in the order they were applied: what the agent is told back. */
  applied: string[];
}

class RevisionRefusal extends Error {}

function refuse(message: string): never {
  throw new RevisionRefusal(message);
}

function field(raw: Record<string, unknown>, name: string, max: number, { required = false, allowEmpty = true } = {}): string | undefined {
  const value = raw[name];
  if (value === undefined) {
    if (required) refuse(`"${name}" is required`);
    return undefined;
  }
  if (typeof value !== "string") refuse(`"${name}" must be text`);
  const trimmed = value.trim();
  if (trimmed === "" && (!allowEmpty || required)) refuse(`"${name}" cannot be empty`);
  if (trimmed.length > max) refuse(`"${name}" must be under ${max} characters`);
  return trimmed;
}

function gateFrom(value: unknown): ProgramDraftGate | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) refuse(`"gate" must be {name, description} or null`);
  const raw = value as Record<string, unknown>;
  return {
    name: field(raw, "name", DRAFT_NAME_MAX, { required: true })!,
    description: field(raw, "description", DRAFT_OVERVIEW_MAX) ?? "",
  };
}

/**
 * Applies an agent's (or anyone's) list of edits to a revision draft body.
 *
 * All or nothing: the first refused change refuses the post, named by its
 * index, and the body is left as it was. Later changes see the effect of
 * earlier ones, so a post can add an item and then depend on it.
 */
export function applyRevisionChanges(body: ProgramDraftBody, input: unknown): DraftValidation<RevisionResult> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const changes = Array.isArray(raw.changes) ? raw.changes : null;
  if (changes === null) return { ok: false, errors: { changes: "Must be an array of changes" } };
  if (changes.length === 0) return { ok: false, errors: { changes: "Nothing to change" } };
  if (changes.length > REVISION_MAX_CHANGES) {
    return { ok: false, errors: { changes: `At most ${REVISION_MAX_CHANGES} changes per post; split it` } };
  }

  const limits = draftLimits(true);
  const draft = JSON.parse(JSON.stringify(body)) as ProgramDraftBody;
  const applied: string[] = [];

  const suiteRef = (value: unknown, name = "suite"): ProgramDraftSuite => {
    if (typeof value !== "string" || value.trim() === "") refuse(`"${name}" must name a suite by key or name`);
    const wanted = value.trim().toLowerCase();
    const suite = draft.suites.find((entry) => entry.key.toLowerCase() === wanted)
      ?? draft.suites.find((entry) => entry.name.toLowerCase() === wanted);
    if (suite === undefined) {
      refuse(`No suite "${value}". Known: ${draft.suites.map((entry) => `${entry.key} (${entry.name})`).join(", ")}`);
    }
    return suite;
  };
  const itemRef = (value: unknown, name = "item"): { suite: ProgramDraftSuite; index: number; prompt: ProgramDraftPrompt } => {
    if (typeof value !== "string" || value.trim() === "") refuse(`"${name}" must be a work item key`);
    const wanted = value.trim().toUpperCase();
    for (const suite of draft.suites) {
      const index = suite.prompts.findIndex((prompt) => prompt.key === wanted);
      if (index >= 0) return { suite, index, prompt: suite.prompts[index]! };
    }
    refuse(`No work item "${value}" in this draft`);
  };
  const allKeys = () => new Set(draft.suites.flatMap((suite) => suite.prompts.map((prompt) => prompt.key)));
  const dependsOnFrom = (value: unknown, self: string | null): string[] => {
    if (!Array.isArray(value)) refuse(`"dependsOn" must be an array of work item keys`);
    const keys = allKeys();
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") refuse(`"dependsOn" must hold keys`);
      const key = entry.trim().toUpperCase();
      if (key === "") continue;
      if (key === self) refuse(`${key} cannot depend on itself`);
      if (!keys.has(key)) refuse(`"dependsOn" names ${key}, which is not in this draft`);
      if (!out.includes(key)) out.push(key);
    }
    return out;
  };
  const assertTitleFree = (suite: ProgramDraftSuite, title: string, except: ProgramDraftPrompt | null) => {
    const clash = suite.prompts.find((prompt) => prompt !== except && prompt.title.toLowerCase() === title.toLowerCase());
    if (clash !== undefined) refuse(`${suite.key} already has a work item titled "${title}" (${clash.key})`);
  };
  const nextSuiteKey = (): string => {
    const used = new Set(draft.suites.map((suite) => suite.key));
    for (let n = draft.suites.length; ; n += 1) if (!used.has(suiteKeyAt(n))) return suiteKeyAt(n);
  };
  const nextItemKey = (suite: ProgramDraftSuite): string => {
    const used = allKeys();
    for (let n = suite.prompts.length + 1; ; n += 1) {
      const key = `${suite.key}-${String(n).padStart(2, "0")}`;
      if (!used.has(key)) return key;
    }
  };
  /** `after` absent: the end. `after: null`: the start. Otherwise: just after that entry. */
  const insertAt = <T>(list: T[], after: unknown, find: (ref: unknown) => number): number => {
    if (after === undefined) return list.length;
    if (after === null) return 0;
    return find(after) + 1;
  };
  const dropDependents = (removed: Set<string>) => {
    for (const suite of draft.suites) {
      for (const prompt of suite.prompts) prompt.dependsOn = prompt.dependsOn.filter((key) => !removed.has(key));
    }
  };

  try {
    changes.forEach((entry, index) => {
      try {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) refuse("Each change must be an object with an \"op\"");
        const change = entry as Record<string, unknown>;
        const op = change.op;
        switch (op) {
          case "update-program": {
            const name = field(change, "name", DRAFT_NAME_MAX, { allowEmpty: false });
            const overview = field(change, "overview", DRAFT_OVERVIEW_MAX);
            const notes = field(change, "notes", DRAFT_NOTES_MAX);
            if (name !== undefined) draft.name = name;
            if (overview !== undefined) draft.overview = overview;
            if (notes !== undefined) draft.notes = notes;
            applied.push("Updated the program");
            break;
          }
          case "add-suite": {
            if (draft.suites.length >= limits.maxSuites) refuse(`A program holds at most ${limits.maxSuites} suites`);
            const name = field(change, "name", DRAFT_NAME_MAX, { required: true })!;
            if (draft.suites.some((suite) => suite.name.toLowerCase() === name.toLowerCase())) refuse(`A suite is already called "${name}"`);
            const suite: ProgramDraftSuite = {
              key: nextSuiteKey(), name, overview: field(change, "overview", DRAFT_OVERVIEW_MAX) ?? "",
              prompts: [], filled: false, sourceId: null,
            };
            draft.suites.splice(insertAt(draft.suites, change.after, (ref) => draft.suites.indexOf(suiteRef(ref, "after"))), 0, suite);
            applied.push(`Added suite ${suite.key} (${suite.name}); give it work items with add-item`);
            break;
          }
          case "update-suite": {
            const suite = suiteRef(change.suite);
            const name = field(change, "name", DRAFT_NAME_MAX, { allowEmpty: false });
            if (name !== undefined && draft.suites.some((other) => other !== suite && other.name.toLowerCase() === name.toLowerCase())) {
              refuse(`A suite is already called "${name}"`);
            }
            const overview = field(change, "overview", DRAFT_OVERVIEW_MAX);
            if (name !== undefined) suite.name = name;
            if (overview !== undefined) suite.overview = overview;
            applied.push(`Updated suite ${suite.key}`);
            break;
          }
          case "move-suite": {
            const suite = suiteRef(change.suite);
            if (!("after" in change)) refuse(`"after" is required: a suite key, or null for the start`);
            if (change.after !== null && suiteRef(change.after, "after") === suite) refuse("A suite cannot move after itself");
            draft.suites.splice(draft.suites.indexOf(suite), 1);
            draft.suites.splice(insertAt(draft.suites, change.after, (ref) => draft.suites.indexOf(suiteRef(ref, "after"))), 0, suite);
            applied.push(`Moved suite ${suite.key}`);
            break;
          }
          case "remove-suite": {
            const suite = suiteRef(change.suite);
            draft.suites.splice(draft.suites.indexOf(suite), 1);
            dropDependents(new Set(suite.prompts.map((prompt) => prompt.key)));
            applied.push(`Removed suite ${suite.key} and its ${suite.prompts.length} work item(s)`);
            break;
          }
          case "add-item": {
            const suite = suiteRef(change.suite);
            if (suite.prompts.length >= limits.maxPromptsPerSuite) refuse(`${suite.key} already holds ${limits.maxPromptsPerSuite} work items`);
            if (draft.suites.reduce((total, entry) => total + entry.prompts.length, 0) >= limits.maxPrompts) {
              refuse(`A program holds at most ${limits.maxPrompts} work items`);
            }
            const title = field(change, "title", DRAFT_TITLE_MAX, { required: true })!;
            assertTitleFree(suite, title, null);
            const key = nextItemKey(suite);
            const prompt: ProgramDraftPrompt = {
              key,
              title,
              content: field(change, "content", limits.contentMax, { required: true })!,
              dependsOn: change.dependsOn === undefined ? [] : dependsOnFrom(change.dependsOn, key),
              gate: change.gate === undefined ? null : gateFrom(change.gate),
              sourceId: null,
            };
            const at = insertAt(suite.prompts, change.after, (ref) => {
              const found = itemRef(ref, "after");
              if (found.suite !== suite) refuse(`"after" must be a work item in ${suite.key}`);
              return found.index;
            });
            suite.prompts.splice(at, 0, prompt);
            suite.filled = true;
            applied.push(`Added ${key} (${title}) to ${suite.key}`);
            break;
          }
          case "update-item": {
            const { suite, prompt } = itemRef(change.item);
            const title = field(change, "title", DRAFT_TITLE_MAX, { allowEmpty: false });
            if (title !== undefined) assertTitleFree(suite, title, prompt);
            const content = field(change, "content", limits.contentMax, { allowEmpty: false });
            if (title !== undefined) prompt.title = title;
            if (content !== undefined) prompt.content = content;
            if (change.dependsOn !== undefined) prompt.dependsOn = dependsOnFrom(change.dependsOn, prompt.key);
            if (change.gate !== undefined) prompt.gate = gateFrom(change.gate);
            applied.push(`Updated ${prompt.key}`);
            break;
          }
          case "move-item": {
            const found = itemRef(change.item);
            const target = change.suite === undefined ? found.suite : suiteRef(change.suite);
            if (target !== found.suite) {
              if (target.prompts.length >= limits.maxPromptsPerSuite) refuse(`${target.key} already holds ${limits.maxPromptsPerSuite} work items`);
              assertTitleFree(target, found.prompt.title, null);
            }
            if (typeof change.after === "string" && change.after.trim().toUpperCase() === found.prompt.key) refuse("A work item cannot move after itself");
            found.suite.prompts.splice(found.index, 1);
            const at = insertAt(target.prompts, change.after, (ref) => {
              const anchor = itemRef(ref, "after");
              if (anchor.suite !== target) refuse(`"after" must be a work item in ${target.key}`);
              return anchor.index;
            });
            target.prompts.splice(at, 0, found.prompt);
            target.filled = true;
            applied.push(target === found.suite ? `Moved ${found.prompt.key} within ${target.key}` : `Moved ${found.prompt.key} to ${target.key}`);
            break;
          }
          case "remove-item": {
            const { suite, index, prompt } = itemRef(change.item);
            suite.prompts.splice(index, 1);
            dropDependents(new Set([prompt.key]));
            applied.push(`Removed ${prompt.key} (${prompt.title})`);
            break;
          }
          case "replace-text": {
            const find = change.find;
            if (typeof find !== "string" || find === "") refuse(`"find" must be non-empty text`);
            if (typeof change.replace !== "string") refuse(`"replace" must be text (use "" to delete)`);
            const replace = change.replace;
            const where = change.in === undefined ? "content" : change.in;
            if (where !== "content" && where !== "title" && where !== "both") refuse(`"in" must be "content", "title" or "both"`);
            const scope = change.items === undefined
              ? null
              : Array.isArray(change.items)
                ? new Set(change.items.map((key) => itemRef(key, "items").prompt.key))
                : refuse(`"items" must be an array of work item keys`);
            let replaced = 0;
            const touched: string[] = [];
            for (const suite of draft.suites) {
              for (const prompt of suite.prompts) {
                if (scope !== null && !scope.has(prompt.key)) continue;
                let hit = false;
                if (where !== "title" && prompt.content.includes(find)) {
                  const next = prompt.content.split(find).join(replace);
                  if (next.length > limits.contentMax) refuse(`${prompt.key}'s instructions would exceed ${limits.contentMax} characters`);
                  replaced += prompt.content.split(find).length - 1;
                  prompt.content = next;
                  hit = true;
                }
                if (where !== "content" && prompt.title.includes(find)) {
                  const next = prompt.title.split(find).join(replace).trim();
                  if (next === "" || next.length > DRAFT_TITLE_MAX) refuse(`${prompt.key}'s title would be empty or too long`);
                  assertTitleFree(suite, next, prompt);
                  replaced += prompt.title.split(find).length - 1;
                  prompt.title = next;
                  hit = true;
                }
                if (hit) touched.push(prompt.key);
              }
            }
            if (replaced === 0) refuse(`"${find.length > 60 ? `${find.slice(0, 60)}…` : find}" was not found; nothing was replaced`);
            applied.push(`Replaced ${replaced} occurrence(s) in ${touched.join(", ")}`);
            break;
          }
          default:
            refuse(`Unknown op ${JSON.stringify(op)}. Known: ${REVISION_OPERATIONS.join(", ")}`);
        }
      } catch (error) {
        if (error instanceof RevisionRefusal) throw new RevisionRefusal(`changes[${index}]: ${error.message}`);
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof RevisionRefusal) {
      const [at, ...rest] = error.message.split(": ");
      return { ok: false, errors: { [at!]: rest.join(": ") } };
    }
    throw error;
  }

  // The bounds every other writer of a draft body is held to, checked once on
  // the result rather than re-derived per operation.
  const normalized = normalizeProgramDraftBody(draft, { revision: true });
  if (!normalized.ok) return normalized;
  return { ok: true, value: { body: normalized.value, applied } };
}

/* -------------------------------------------------------------------------- */
/* What a revision changes                                                     */
/* -------------------------------------------------------------------------- */

export type RevisionChangeKind = "added" | "removed" | "changed" | "moved";

export interface ProgramRevisionChange {
  scope: "program" | "suite" | "item";
  kind: RevisionChangeKind;
  /** The draft key (or the baseline's, for a removal). Empty for the program. */
  key: string;
  label: string;
  details: string[];
}

function sameGate(a: ProgramDraftGate | null, b: ProgramDraftGate | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.description === b.description;
}

function lineDelta(before: string, after: string): string {
  const was = before.split("\n");
  const now = after.split("\n");
  const wasSet = new Map<string, number>();
  for (const line of was) wasSet.set(line, (wasSet.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of now) {
    const left = wasSet.get(line) ?? 0;
    if (left > 0) wasSet.set(line, left - 1);
    else added += 1;
  }
  const removed = [...wasSet.values()].reduce((total, count) => total + count, 0);
  return `instructions edited (+${added} / −${removed} lines)`;
}

/**
 * The operator's reading list: everything a revision draft would change,
 * matched by `sourceId` rather than key or position, so a renamed or moved
 * work item reads as renamed or moved and not as one removal and one addition.
 */
export function diffProgramRevision(baseline: ProgramDraftBody, draft: ProgramDraftBody): ProgramRevisionChange[] {
  const changes: ProgramRevisionChange[] = [];

  const programDetails: string[] = [];
  if (baseline.name !== draft.name) programDetails.push(`renamed from "${baseline.name}"`);
  if (baseline.overview !== draft.overview) programDetails.push("overview edited");

  const baseSuites = new Map<number, { suite: ProgramDraftSuite; index: number }>();
  baseline.suites.forEach((suite, index) => { if (typeof suite.sourceId === "number") baseSuites.set(suite.sourceId, { suite, index }); });
  const baseItems = new Map<number, { prompt: ProgramDraftPrompt; suite: ProgramDraftSuite }>();
  for (const suite of baseline.suites) for (const prompt of suite.prompts) {
    if (typeof prompt.sourceId === "number") baseItems.set(prompt.sourceId, { prompt, suite });
  }
  // Dependencies compare by identity, so a key that was reassigned is not a change.
  const identity = (body: ProgramDraftBody) => {
    const byKey = new Map<string, string>();
    for (const suite of body.suites) for (const prompt of suite.prompts) {
      byKey.set(prompt.key, typeof prompt.sourceId === "number" && baseItems.has(prompt.sourceId) ? `#${prompt.sourceId}` : `new:${prompt.key}`);
    }
    return byKey;
  };
  const baseIdentity = identity(baseline);
  const draftIdentity = identity(draft);

  const seenSuites = new Set<number>();
  const retainedSuiteOrder: number[] = [];
  for (const suite of draft.suites) {
    const base = typeof suite.sourceId === "number" && !seenSuites.has(suite.sourceId) ? baseSuites.get(suite.sourceId) : undefined;
    if (base === undefined) {
      changes.push({ scope: "suite", kind: "added", key: suite.key, label: suite.name, details: [`${suite.prompts.length} work item(s)`] });
      continue;
    }
    seenSuites.add(suite.sourceId!);
    retainedSuiteOrder.push(suite.sourceId!);
    const details: string[] = [];
    if (base.suite.name !== suite.name) details.push(`renamed from "${base.suite.name}"`);
    if (base.suite.overview !== suite.overview) details.push("overview edited");
    const baseOrder = base.suite.prompts.map((prompt) => prompt.sourceId).filter((id): id is number => typeof id === "number");
    const draftOrder = suite.prompts.map((prompt) => prompt.sourceId).filter((id): id is number => typeof id === "number" && baseOrder.includes(id));
    const baseKept = baseOrder.filter((id) => draftOrder.includes(id));
    if (baseKept.join(",") !== draftOrder.join(",")) details.push("work items reordered");
    if (details.length > 0) changes.push({ scope: "suite", kind: "changed", key: suite.key, label: suite.name, details });
  }
  const baseSuiteOrder = baseline.suites.map((suite) => suite.sourceId).filter((id): id is number => typeof id === "number" && retainedSuiteOrder.includes(id));
  if (baseSuiteOrder.join(",") !== retainedSuiteOrder.join(",")) programDetails.push("suites reordered");
  for (const [id, base] of baseSuites) {
    if (!seenSuites.has(id)) {
      changes.push({ scope: "suite", kind: "removed", key: base.suite.key, label: base.suite.name, details: [`with its ${base.suite.prompts.length} work item(s)`] });
    }
  }

  const seenItems = new Set<number>();
  for (const suite of draft.suites) {
    for (const prompt of suite.prompts) {
      const base = typeof prompt.sourceId === "number" && !seenItems.has(prompt.sourceId) ? baseItems.get(prompt.sourceId) : undefined;
      if (base === undefined) {
        changes.push({
          scope: "item", kind: "added", key: prompt.key, label: prompt.title,
          details: [`in ${suite.key}`, ...(prompt.dependsOn.length > 0 ? [`after ${prompt.dependsOn.join(", ")}`] : [])],
        });
        continue;
      }
      seenItems.add(prompt.sourceId!);
      const details: string[] = [];
      if (base.suite.sourceId !== suite.sourceId || typeof suite.sourceId !== "number") {
        details.push(`moved from ${base.suite.key} to ${suite.key}`);
      }
      if (base.prompt.title !== prompt.title) details.push(`retitled from "${base.prompt.title}"`);
      if (base.prompt.content !== prompt.content) details.push(lineDelta(base.prompt.content, prompt.content));
      const was = base.prompt.dependsOn.map((key) => baseIdentity.get(key) ?? key).sort().join(",");
      const now = prompt.dependsOn.map((key) => draftIdentity.get(key) ?? key).sort().join(",");
      if (was !== now) details.push(`dependencies: ${base.prompt.dependsOn.join(", ") || "none"} → ${prompt.dependsOn.join(", ") || "none"}`);
      if (!sameGate(base.prompt.gate, prompt.gate)) {
        details.push(prompt.gate === null ? "gate removed" : base.prompt.gate === null ? `gate added: ${prompt.gate.name}` : "gate edited");
      }
      if (details.length > 0) {
        changes.push({
          scope: "item",
          kind: details.length === 1 && details[0]!.startsWith("moved") ? "moved" : "changed",
          key: prompt.key, label: prompt.title, details,
        });
      }
    }
  }
  for (const [id, base] of baseItems) {
    if (!seenItems.has(id) && seenSuites.has(base.suite.sourceId ?? -1)) {
      changes.push({ scope: "item", kind: "removed", key: base.prompt.key, label: base.prompt.title, details: [`from ${base.suite.key}`] });
    }
  }

  if (programDetails.length > 0) {
    changes.unshift({ scope: "program", kind: "changed", key: "", label: draft.name, details: programDetails });
  }
  return changes;
}
