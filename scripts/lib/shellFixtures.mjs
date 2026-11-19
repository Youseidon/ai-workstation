// Mocked agent-server API for the shell browser scripts. One source of fixture
// data for verify-shell-browser, capture-shell-screenshots and
// verify-shell-performance.
//
// createFixtures({ scale, mode }):
//   scale — sizes for the large fixtures (sessions, pipelines, changes, files, diffLines)
//   mode  — 'normal' | 'empty' (a workspace with no records) | 'error' (API 500s) | 'loading' (API never answers)
import { pathToFileURL } from 'node:url';

export async function launchBrowser() {
  const { chromium } = await import(process.env.CHAT_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.CHAT_PLAYWRIGHT_MODULE).href : 'playwright');
  return chromium.launch({ headless: true, executablePath: process.env.CHAT_BROWSER_EXECUTABLE, args: ['--no-sandbox'] });
}

export function createFixtures({ scale = {}, mode = 'normal' } = {}) {
  const now = new Date().toISOString();
  const workspace = (id, name) => ({ id, name, description: '', workDirectory: `/tmp/project-${id}`, workDirectoryExists: id === 1, createdAt: now, updatedAt: now, claudeMd: '', agentsMd: '' });
  const workspaces = [workspace(1, 'ai-orchestration'), workspace(2, 'Review project')];
  const session = (id, workspaceId, title, extra = {}) => ({ id, threadId: null, threadTitle: null, providerSessionId: null, workspaceId, workspaceName: workspaces[workspaceId - 1].name, workDirectory: `/tmp/project-${workspaceId}`, role: 'execute', provider: 'codex', model: null, startedAt: now, endedAt: now, displayText: title, promptTitle: title, promptId: null, promptKey: null, programName: '', suiteName: '', state: 'DONE', events: [], changes: null, ...extra });
  const sessions = [session('run-a', 1, 'Refactor the shell'), session('run-b', 1, 'Investigate flaky test', { state: 'ERROR' }), session('run-c', 2, 'Other workspace run')];
  for (let index = 0; index < (scale.sessions ?? 0); index++) sessions.push(session(`bulk-${index}`, 1, `Bulk session ${index}`, { startedAt: new Date(Date.now() - index * 60000).toISOString() }));
  const change = (runId, title) => ({ runId, promptTitle: title, workspaceId: 1, repositoryRoot: '/tmp/project-1', branch: 'main', baseCommit: 'aaaaaaaa1', headCommit: 'bbbbbbbb2', state: 'COMMITTED', filesChanged: 2, additions: 12, deletions: 3, commitCount: 1, message: `Commit for ${title}`, capturedAt: now, updatedAt: now, pipeline: null });
  const changes = [change('run-a', 'Refactor the shell'), change('run-x', 'Add sidebar collections')];
  for (let index = 0; index < (scale.changes ?? 0); index++) changes.push(change(`bulk-change-${index}`, `Bulk change ${index}`));
  const files = [{ path: 'web/app/page.tsx', previousPath: null, status: 'modified', additions: 10, deletions: 2 }, { path: 'web/lib/navigation.tsx', previousPath: null, status: 'added', additions: 2, deletions: 1 }];
  for (let index = 0; index < (scale.files ?? 0); index++) files.push({ path: `web/generated/file-${index}.ts`, previousPath: null, status: 'modified', additions: 4, deletions: 4 });
  const stage = { suiteId: 11, programName: 'Platform', programKey: 'P1', suiteName: 'Shell', suiteKey: 'S11', promptCount: 0, stepCount: 0 };
  const pipelineRecord = (id, name) => ({ id, workspaceId: 1, name, stages: id === 7 ? [stage] : [], active: null, latest: null, createdAt: now, updatedAt: now });
  const suite = (id, name) => ({ id, programId: 1, name, externalKey: `S${id}`, overview: '', position: id, prompts: [], createdAt: now, updatedAt: now });
  const program = { id: 1, workspaceId: 1, name: 'Platform', externalKey: 'P1', overview: '', position: 1, suites: [suite(11, 'Shell'), suite(12, 'Collections')], createdAt: now, updatedAt: now };
  const pipelines = [{ pipeline: pipelineRecord(7, 'Release train'), totalSteps: 4, completedSteps: 1, attentionCount: 1, lastRunDurationMs: null }, { pipeline: pipelineRecord(8, 'Docs sweep'), totalSteps: 0, completedSteps: 0, attentionCount: 0, lastRunDurationMs: null }];
  for (let index = 0; index < (scale.pipelines ?? 0); index++) pipelines.push({ pipeline: pipelineRecord(100 + index, `Bulk pipeline ${index}`), totalSteps: 10, completedSteps: index % 10, attentionCount: index % 7 === 0 ? 1 : 0, lastRunDurationMs: 60000 });
  const dashboard = { generatedAt: now, summary: { pipelineCount: pipelines.length, activePipelineCount: 0, completedSteps: 0, totalSteps: 0, pendingSteps: 0, attentionCount: 0, runsLast7Days: 0, avgRunDurationMs: null }, pipelines, blockedStations: [], throughput: [] };
  const totals = { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1500, estimatedUsd: 0.42, sessionCount: 2, sessionsWithUsage: 1, sessionsWithoutUsage: 1 };
  const patchFor = (path) => {
    const lines = scale.diffLines ?? 2;
    const body = [];
    for (let index = 0; index < lines / 2; index++) body.push(`-old ${path} line ${index}`, `+new ${path} line ${index}`);
    return `@@ -1,${lines / 2} +1,${lines / 2} @@\n${body.join('\n')}`;
  };
  // An empty workspace 2 shows every empty state; workspace 1 holds the records.
  const empty = mode === 'empty';
  const requests = [];

  async function api(route) {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    const p = url.pathname;
    requests.push({ method: request.method(), path: p, search: url.search, at: Date.now() });
    if (mode === 'loading' && p !== '/api/workspaces') return; // never answers: the page stays in its loading state
    if (mode === 'error' && p !== '/api/workspaces') { await route.fulfill({ status: 500, contentType: 'application/json', headers, body: JSON.stringify({ error: { code: 'internal', message: 'The agent server failed (fixture)' } }) }); return; }
    let data = {}, status = 200;
    if (p === '/api/workspaces') data = { workspaces };
    else if (/^\/api\/workspaces\/\d+\/tree$/.test(p)) data = { workspace: { ...workspaces[Number(p.split('/')[3]) - 1], programs: p.includes('/1/') && !empty ? [program] : [] } };
    else if (/instruction-proposals$/.test(p)) data = { proposals: [] };
    else if (/\/threads$/.test(p)) data = { threads: [], next: null };
    else if (p === '/api/sessions') data = { sessions: empty ? [] : sessions };
    else if (p.startsWith('/api/sessions/')) data = { session: sessions.find((s) => s.id === decodeURIComponent(p.split('/')[3])) ?? sessions[0] };
    else if (p === '/api/changes') data = { changes: empty ? [] : changes };
    else if (p === '/api/report') data = { report: { generatedAt: now, pricingNote: 'API list-rate estimate.', totals: empty ? { ...totals, totalTokens: 0, estimatedUsd: 0, sessionCount: 0, sessionsWithUsage: 0, sessionsWithoutUsage: 0 } : totals, byProvider: empty ? [] : [{ provider: 'codex', totals }], suites: [], unassigned: { totals, sessionIds: [] }, sessions: [] } };
    else if (/^\/api\/runs\/[^/]+\/changes$/.test(p)) data = url.searchParams.has('path') ? { file: { runId: 'run-a', path: url.searchParams.get('path'), previousPath: null, patch: patchFor(url.searchParams.get('path')), truncated: false } } : { changes: { ...changes[0], commits: [{ sha: 'bbbbbbbb2', subject: 'Refactor the shell', author: 'agent', authoredAt: now }], files } };
    else if (p === '/api/operations') data = { generatedAt: now, suites: [], policy: {}, statusCatalog: [], triggerSentences: {} };
    else if (p === '/api/pipelines/7') data = { pipeline: pipelines[0].pipeline };
    else if (/^\/api\/pipelines\/\d+\/runs$/.test(p)) data = { runs: [] };
    else if (p === '/api/pipelines') data = url.searchParams.has('dashboard') ? (empty ? { ...dashboard, pipelines: [] } : dashboard) : { pipelines: empty ? [] : pipelines.map((item) => item.pipeline) };
    else { status = 404; data = { error: { code: 'not_found', message: `No fixture for ${p}` } }; }
    await route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(data) });
  }

  return { api, requests, now, workspaces, sessions, changes, files, pipelines };
}
