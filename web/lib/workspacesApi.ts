import type { AgentSession, ApiErrorBody, HumanInputRequest, OperationsSnapshot, PromptActivity, PromptOption, PromptRemark, PromptStatusEvent, SuiteVerificationContext, SuiteVerificationDetail, SuiteVerificationRecord, WorkspaceRecord, WorkspaceTree } from "@agent-console/shared";

export class ApiError extends Error {
  constructor(message: string, public fields?: Record<string, string>) { super(message); }
}

async function request<T>(serverUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, serverUrl), { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (!response.ok) {
    let data: ApiErrorBody | null = null;
    try { data = await response.json() as ApiErrorBody; } catch { /* use status text */ }
    throw new ApiError(data?.error.message ?? response.statusText, data?.error.fields);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const json = (value: unknown): RequestInit => ({ body: JSON.stringify(value) });

export const workspaceApi = {
  async sessions(serverUrl:string){return (await request<{sessions:AgentSession[]}>(serverUrl,"/api/sessions")).sessions;},
  operations(serverUrl:string,workspaceId?:number){return request<OperationsSnapshot>(serverUrl,`/api/operations${workspaceId===undefined?"":`?workspace=${workspaceId}`}`);},
  /** Records a fresh audit of what the orchestration records already claim. */
  auditSuite(serverUrl:string,suiteId:number){return request<{verification:SuiteVerificationRecord}>(serverUrl,`/api/suites/${suiteId}/verification`,{method:"POST",body:"{}"}).then(r=>r.verification);},
  verifications(serverUrl:string,suiteId:number){return request<{verifications:SuiteVerificationRecord[]}>(serverUrl,`/api/suites/${suiteId}/verifications`).then(r=>r.verifications);},
  verification(serverUrl:string,id:number){return request<{verification:SuiteVerificationDetail}>(serverUrl,`/api/verifications/${id}`).then(r=>r.verification);},
  verificationContext(serverUrl:string,suiteId:number){return request<SuiteVerificationContext>(serverUrl,`/api/suites/${suiteId}/verification-context`);},
  activity(serverUrl:string,promptId:number){return request<PromptActivity>(serverUrl,`/api/prompts/${promptId}/activity`);},
  interruptRun(serverUrl:string,runId:string){return request<{interrupted:boolean}>(serverUrl,`/api/runs/${encodeURIComponent(runId)}/interrupt`,{method:"POST",...json({})});},
  async list(serverUrl: string) { return (await request<{ workspaces: WorkspaceRecord[] }>(serverUrl, "/api/workspaces")).workspaces; },
  async tree(serverUrl: string, id: number) { return (await request<{ workspace: WorkspaceTree }>(serverUrl, `/api/workspaces/${id}/tree`)).workspace; },
  async prompts(serverUrl: string, id: number) { return (await request<{ prompts: PromptOption[] }>(serverUrl, `/api/workspaces/${id}/prompts`)).prompts; },
  create(serverUrl: string, value: unknown) { return request(serverUrl, "/api/workspaces", { method: "POST", ...json(value) }); },
  update(serverUrl: string, id: number, value: unknown) { return request(serverUrl, `/api/workspaces/${id}`, { method: "PATCH", ...json(value) }); },
  remove(serverUrl: string, id: number) { return request<void>(serverUrl, `/api/workspaces/${id}`, { method: "DELETE" }); },
  createChild(serverUrl: string, parent: "workspaces"|"programs"|"suites", id: number, child: "programs"|"suites"|"prompts", value: unknown) { return request(serverUrl, `/api/${parent}/${id}/${child}`, { method: "POST", ...json(value) }); },
  updateChild(serverUrl: string, kind: "programs"|"suites"|"prompts", id: number, value: unknown) { return request(serverUrl, `/api/${kind}/${id}`, { method: "PATCH", ...json(value) }); },
  removeChild(serverUrl: string, kind: "programs"|"suites"|"prompts", id: number) { return request<void>(serverUrl, `/api/${kind}/${id}`, { method: "DELETE" }); },
  history(serverUrl:string,id:number){return request<{events:PromptStatusEvent[];remarks:PromptRemark[];runs:unknown[]}>(serverUrl,`/api/prompts/${id}/history`);},
  humanInput(serverUrl:string){return request<{requests:HumanInputRequest[]}>(serverUrl,"/api/prompts/human-input");},
  respond(serverUrl:string,id:number,content:string){return request<{remark:PromptRemark}>(serverUrl,`/api/prompts/${id}/human-response`,{method:"POST",...json({content})});},
  recover(serverUrl:string,id:number){return request<{recovered:boolean}>(serverUrl,`/api/prompts/${id}/recover`,{method:"POST",...json({})});},
};
