export const RUN_CHANGE_STATES = ["PENDING", "UNCHANGED", "COMMITTED", "NEEDS_COMMIT", "UNAVAILABLE"] as const;
export type RunChangeState = (typeof RUN_CHANGE_STATES)[number];

export interface RunChangeSummary {
  runId:string;
  promptTitle:string;
  workspaceId:number;
  repositoryRoot:string;
  branch:string|null;
  baseCommit:string;
  headCommit:string|null;
  state:RunChangeState;
  filesChanged:number;
  additions:number;
  deletions:number;
  commitCount:number;
  message:string|null;
  capturedAt:string;
  updatedAt:string;
  pipeline:{id:number;name:string}|null;
}

export interface RunCommit {
  sha:string;
  subject:string;
  author:string;
  authoredAt:string;
}

export interface RunChangedFile {
  path:string;
  previousPath:string|null;
  status:"added"|"modified"|"deleted"|"renamed"|"copied"|"type-changed"|"unknown";
  additions:number|null;
  deletions:number|null;
  binary:boolean;
}

export interface RunChangeDetail extends RunChangeSummary {
  commits:RunCommit[];
  files:RunChangedFile[];
}

export interface RunFileDiff {
  runId:string;
  path:string;
  previousPath:string|null;
  patch:string;
  truncated:boolean;
}
