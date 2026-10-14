import type { AgentInputAnswer, AgentInputRequestPayload, AgentQuestionKind } from "@agent-console/shared";
import { newId } from "./lib/ids.ts";
import { WorkspaceError } from "./workspaces.ts";

interface PendingInput {
  runId: string;
  request: AgentInputRequestPayload;
  promise: Promise<Record<string, AgentInputAnswer>>;
  resolve(answers: Record<string, AgentInputAnswer>): void;
  reject(error: Error): void;
}

const pending = new Map<string, PendingInput>();
const completed = new Map<string, { requestId: string; answers: Record<string, AgentInputAnswer>; expiresAt: number }>();
const COMPLETED_TTL_MS = 12 * 60 * 60 * 1000;

function pruneCompleted(): void {
  const now = Date.now();
  for (const [runId, entry] of completed) if (entry.expiresAt <= now) completed.delete(runId);
}

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** Validates the deliberately small format accepted from every provider. */
export function normalizeAgentInputRequest(input: Record<string, unknown>): AgentInputRequestPayload {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  if (rawQuestions.length === 0 || rawQuestions.length > 8) {
    throw new WorkspaceError(422, "validation_error", "Ask between 1 and 8 questions.");
  }
  const seen = new Set<string>();
  const questions = rawQuestions.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new WorkspaceError(422, "validation_error", `Question ${index + 1} is not an object.`);
    }
    const value = raw as Record<string, unknown>;
    const id = clean(value.id, 80) || `question_${index + 1}`;
    const prompt = clean(value.prompt ?? value.question, 2000);
    const kind: AgentQuestionKind = value.kind === "single" || value.kind === "multiple" || value.kind === "text"
      ? value.kind
      : "text";
    if (seen.has(id)) throw new WorkspaceError(422, "validation_error", `Question id "${id}" is duplicated.`);
    if (prompt === "") throw new WorkspaceError(422, "validation_error", `Question ${index + 1} needs a prompt.`);
    seen.add(id);
    const rawOptions = Array.isArray(value.options) ? value.options : [];
    const options = rawOptions.slice(0, 12).map((option, optionIndex) => {
      if (typeof option === "string") {
        const label = clean(option, 500);
        return { value: label || `option_${optionIndex + 1}`, label, description: null };
      }
      const record = option !== null && typeof option === "object" && !Array.isArray(option)
        ? option as Record<string, unknown>
        : {};
      const label = clean(record.label ?? record.value, 500);
      return {
        value: clean(record.value, 200) || label || `option_${optionIndex + 1}`,
        label: label || `Option ${optionIndex + 1}`,
        description: clean(record.description, 1000) || null,
      };
    });
    if (kind !== "text" && options.length < 2) {
      throw new WorkspaceError(422, "validation_error", `Question "${id}" needs at least two options.`);
    }
    const recommendation = clean(value.recommendation, 200) || null;
    if (recommendation !== null && kind !== "text" && !options.some((option) => option.value === recommendation)) {
      throw new WorkspaceError(422, "validation_error", `Question "${id}" recommends an unknown option.`);
    }
    return {
      id,
      prompt,
      kind,
      options: kind === "text" ? [] : options,
      required: value.required !== false,
      recommendation,
      why: clean(value.why, 1500) || null,
    };
  });
  return {
    requestId: clean(input.requestId, 100) || newId("input"),
    heading: clean(input.heading, 500) || (questions.length === 1 ? "One decision before I continue" : `${questions.length} decisions before I continue`),
    questions,
  };
}

export function waitForAgentInput(runId: string, request: AgentInputRequestPayload): { answers: Promise<Record<string, AgentInputAnswer>>; registered: boolean } {
  pruneCompleted();
  const settled = completed.get(runId);
  if (settled?.requestId === request.requestId) {
    return { answers: Promise.resolve(settled.answers), registered: false };
  }
  const existing = pending.get(runId);
  if (existing !== undefined) {
    if (existing.request.requestId !== request.requestId) {
      throw new WorkspaceError(409, "input_already_pending", "This run is already waiting for input.");
    }
    return { answers: existing.promise, registered: false };
  }
  let resolve!: (answers: Record<string, AgentInputAnswer>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Record<string, AgentInputAnswer>>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  }).finally(() => {
    if (pending.get(runId)?.request.requestId === request.requestId) pending.delete(runId);
  });
  pending.set(runId, { runId, request, promise, resolve, reject });
  return { answers: promise, registered: true };
}

export function answerAgentInput(runId: string, requestId: string, answers: Record<string, AgentInputAnswer>): AgentInputRequestPayload {
  const entry = pending.get(runId);
  if (entry === undefined || entry.request.requestId !== requestId) {
    throw new WorkspaceError(409, "input_not_pending", "That input request is no longer waiting for an answer.");
  }
  const normalized: Record<string, AgentInputAnswer> = {};
  for (const question of entry.request.questions) {
    const answer = answers[question.id];
    if (question.kind === "multiple") {
      const values = Array.isArray(answer) ? answer.filter((value): value is string => typeof value === "string") : [];
      const allowed = new Set(question.options.map((option) => option.value));
      if (values.some((value) => value !== "__agent_decide__" && !allowed.has(value))) throw new WorkspaceError(422, "validation_error", `Answer for "${question.id}" contains an unknown option.`);
      if (question.required && values.length === 0) throw new WorkspaceError(422, "validation_error", `Answer "${question.id}" before continuing.`);
      normalized[question.id] = [...new Set(values)];
      continue;
    }
    const value = typeof answer === "string" ? answer.trim().slice(0, 10_000) : "";
    if (question.required && value === "") throw new WorkspaceError(422, "validation_error", `Answer "${question.id}" before continuing.`);
    if (question.kind === "single" && value !== "" && value !== "__agent_decide__" && !question.options.some((option) => option.value === value)) {
      throw new WorkspaceError(422, "validation_error", `Answer for "${question.id}" is not one of its options.`);
    }
    normalized[question.id] = value;
  }
  completed.set(runId, { requestId, answers: normalized, expiresAt: Date.now() + COMPLETED_TTL_MS });
  entry.resolve(normalized);
  return entry.request;
}

export function cancelAgentInput(runId: string): void {
  const entry = pending.get(runId);
  if (entry === undefined) return;
  entry.reject(new Error("The run ended before its input request was answered."));
  pending.delete(runId);
}
