import type { ControlOutcome, ControlRecord, ControlRecordRemote } from "./teamControlRecord.ts";

/**
 * Capture, preview and publish: the requester's half of handover (H03, TM-T0-7).
 *
 * Skeleton only, landed with the assertions so the red falls on behaviour rather
 * than on module resolution. Every entry point throws until the implementation
 * lands in the next commit.
 */

export type CredentialShapeId =
  | "private_key" | "aws_access_key_id" | "github_token" | "provider_api_key"
  | "telegram_bot_token" | "bearer_token" | "assigned_secret" | "credential_filename";

export interface CredentialShape {
  id: CredentialShapeId;
  label: string;
}

export const CREDENTIAL_SHAPES: readonly CredentialShape[] = [];

/** A package this large is called out in the preview rather than pushed quietly. */
export const LARGE_PACKAGE_BYTES = 100 * 1024 * 1024;

export function detectCredentialShapes(_content: string, _path?: string): CredentialShapeId[] {
  throw new Error("not implemented");
}

export interface CapturedFile {
  path: string;
  /** The two-character porcelain code: index letter, then worktree letter. */
  status: string;
  mode: string;
  bytes: number;
  shapes: CredentialShapeId[];
}

export interface HandoverContext {
  version: 1;
  itemId: string;
  objective: string;
  requirements: string[];
  answers: string[];
  openQuestions: string[];
  completed: string[];
  pending: string[];
  verification: string[];
  recommendedProvider: string;
  recommendedModel: string | null;
  baseline: { head: string; staged: string[]; worktree: string[] };
  summary: string | null;
}

export type HandoverConfirmation = "credential_exposure" | "publish";

export interface CapturePreview {
  itemId: string;
  requester: string;
  provider: string;
  model: string | null;
  branch: string;
  baseCommit: string;
  snapshotCommit: string;
  contextPath: string;
  workDirectory: string;
  files: CapturedFile[];
  excluded: string[];
  flagged: Array<{ path: string; shapes: CredentialShapeId[] }>;
  totalBytes: number;
  largestBytes: number;
  large: boolean;
  /** Always false: the preview warns and never refuses (jd's ruling of 2026-09-20). */
  blocked: boolean;
  requiredConfirmations: HandoverConfirmation[];
  risk: string;
  mitigation: string;
  context: HandoverContext;
  waitedForRuns: number;
}

export interface CaptureInput {
  itemId: string;
  requester: string;
  provider: string;
  model?: string | null;
  now?: Date;
  largeBytesThreshold?: number;
  idleWait?: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void> };
  /** A seam for the concurrent-editor and local-completion cases. */
  hooks?: { duringCapture?: () => void };
}

export function beginHandover(
  _remote: ControlRecordRemote,
  _input: { itemId: string; requester: string; commandId: string; now?: Date; workstationId?: string },
): Promise<ControlOutcome> {
  throw new Error("not implemented");
}

export function captureHandoverPackage(_input: CaptureInput): Promise<CapturePreview> {
  throw new Error("not implemented");
}

export function attachHandoverSummary(_preview: CapturePreview, _summarize: () => Promise<string>): Promise<CapturePreview> {
  throw new Error("not implemented");
}

export interface HandoverPackageRemote {
  /** Uploads the package objects. "uncertain" means the outcome is unknown. */
  publish(commit: string, branch: string): Promise<"published" | "uncertain">;
  /** Reads the objects back out of the remote; false when they are not retrievable. */
  verify(commit: string, branch: string): Promise<boolean>;
}

export class BareGitHandoverPackageRemote implements HandoverPackageRemote {
  constructor(private readonly sourceDirectory: string, private readonly bareDirectory: string) {}
  publish(_commit: string, _branch: string): Promise<"published" | "uncertain"> {
    throw new Error("not implemented");
  }
  verify(_commit: string, _branch: string): Promise<boolean> {
    throw new Error("not implemented");
  }
}

export interface PublishedOffer {
  itemId: string;
  branch: string;
  snapshotCommit: string;
  packageHash: string;
  provider: string;
  model: string | null;
  /** The offer is an open call: it names no receiver (ruled 2026-09-20). */
  receiver: null;
  epoch: number;
  startDeadline: string;
}

export interface PublishInput {
  preview: CapturePreview;
  control: ControlRecordRemote;
  packages: HandoverPackageRemote;
  commandId: string;
  actor: { personId: string; workstationId?: string };
  confirmations: HandoverConfirmation[];
  acknowledgedBytes: number;
  now?: Date;
}

export function publishHandoverOffer(_input: PublishInput): Promise<{ outcome: ControlOutcome; offer: PublishedOffer }> {
  throw new Error("not implemented");
}

export function readPublishedOffer(_record: ControlRecord, _remote: ControlRecordRemote): Promise<PublishedOffer | null> {
  throw new Error("not implemented");
}
