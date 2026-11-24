// Run against a production frontend with all agent/network traffic mocked.
// SHELL_BASE_URL=http://127.0.0.1:3917 CHAT_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/verify-fleet-browser.mjs
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixtures, launchBrowser } from './lib/shellFixtures.mjs';

const base = process.env.SHELL_BASE_URL ?? 'http://127.0.0.1:3917';
const output = await mkdtemp(join(tmpdir(), 'fleet-browser-'));
const fixtures = createFixtures();
const providers = [['codex', 'Codex CLI'], ['claude', 'Claude Code'], ['cursor', 'Cursor CLI'], ['grok', 'Grok CLI'], ['copilot', 'GitHub Copilot'], ['kilocode', 'Kilo Code']].map(([id, label]) => ({ id, label, available: id !== 'kilocode', reason: id === 'kilocode' ? 'Turned off on the Agents page' : null, version: '1.0', transport: 'spawn', binary: id, reportsTokens: true, permissionMode: 'workspace-write', model: `${id}-configured-default`, configuredModel: `${id}-configured-default`, models: [{ id: `${id}-configured-default`, label: `${id} configured default` }], modelAccessTier: 'all', modelSelectionMode: 'manual', reasoningEffort: 'medium', tierDefaultModel: null, totalModels: 1, cooling: null }));
const startedAt = new Date(Date.now() - 754000).toISOString();
const questionAt = new Date(Date.parse(startedAt) + 680000).toISOString();
const makeRun = (runId, provider, workspace, source, role = 'execute') => ({ runId, provider, model: `${provider}-actual-run-model`, role, workspace, source, state: 'running', elapsedMs: 754000, startedAt, usage: null, detail: null, truncated: false, permissionMode: 'workspace-write', events: [] });
let liveRuns = [
  makeRun('pipeline-run', 'codex', fixtures.workspaces[0], { type: 'saved', promptId: 5, promptKey: 'P5', title: 'Build API', programName: 'Platform', suiteName: 'Shell' }),
  makeRun('custom-run', 'claude', fixtures.workspaces[1], { type: 'custom', displayText: 'Refine navigation', title: 'Navigation refresh', threadId: 'thread-custom' }),
  makeRun('consult-run', 'codex', fixtures.workspaces[0], { type: 'consult', promptId: 5, promptKey: 'P5', title: 'Review architecture', question: 'Review architecture' }, 'consult'),
  makeRun('waiting-run', 'cursor', fixtures.workspaces[1], { type: 'custom', displayText: 'Review schema', title: 'Review schema', threadId: 'thread-waiting' }, 'consult'),
];
const question = { id: 'q1', prompt: 'Which schema should I use?', kind: 'single', options: [{ value: 'existing', label: 'Existing schema', description: null }, { value: 'new', label: 'New schema', description: null }], required: true, recommendation: null, why: null };
liveRuns[3].events = [{ id: 'input-1', runId: 'waiting-run', provider: 'cursor', model: 'cursor-actual-run-model', timestamp: questionAt, type: 'input_request', payload: { requestId: 'request-1', heading: 'Choose a schema', questions: [question] } }];
const prompt = { prompt: { id: 6, title: 'Verify release' }, children: [], pipelineRule: { provider: 'grok', model: null } };
const suiteRun = { id: 'suite-live', pipelineRunId: 'pipeline-live', state: 'PLAYING', currentRunId: 'pipeline-run', currentPromptId: 5, playProvider: 'codex', playModel: null };
const operations = { generatedAt: startedAt, policy: {}, statusCatalog: [], triggerSentences: {}, suites: [
  { id: 11, name: 'Shell', programName: 'Platform', workspaceId: 1, workspaceName: 'ai-orchestration', prompts: [], pipeline: { active: suiteRun, defaults: { defaultProvider: 'codex', defaultModel: null } } },
  { id: 12, name: 'Verification', programName: 'Platform', workspaceId: 1, workspaceName: 'ai-orchestration', prompts: [prompt], pipeline: { active: { ...suiteRun, id: 'queued-suite', pipelineRunId: 'queued-pipeline', currentRunId: null, currentPromptId: 6 }, defaults: { defaultProvider: 'grok', defaultModel: null } } },
] };
const pipelines = fixtures.pipelines.map((item, index) => ({ ...item.pipeline, active: { id: index ? 'queued-pipeline' : 'pipeline-live' } }));
const sockets = new Set();
const sent = [];
let metadataError = false;
let simulateDisconnect = false;
async function api(route) {
  const path = new URL(route.request().url()).pathname;
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,PUT,OPTIONS' };
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
  let body;
  if (path === '/api/providers' || path === '/api/providers/refresh') body = { providers };
  else if (path === '/api/providers/usage') body = { usage: [] };
  else if (path === '/api/settings') body = { fields: [], groups: [] };
  else if (path === '/api/operations') {
    if (metadataError) return route.fulfill({ status: 503, headers, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Metadata fixture offline' } }) });
    body = operations;
  } else if (path === '/api/pipelines' && !new URL(route.request().url()).searchParams.has('dashboard')) body = { pipelines };
  else if (path === '/api/pipelines/8/flowchart') body = { steps: [{ promptId: 6, provider: 'grok', model: 'scoped-grok-model' }], subSteps: [], defaults: { defaultProvider: 'codex', defaultModel: 'codex-only' } };
  else return fixtures.api(route);
  return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(body) });
}
function broadcast(message) { for (const socket of sockets) socket.send(JSON.stringify(message)); }
const frontend = process.argv.includes('--start') ? spawn(process.execPath, ['../node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', new URL(base).port], { cwd: fileURLToPath(new URL('../web', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] }) : null;
if (frontend) await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Frontend did not start')), 15000);
  frontend.stdout.on('data', data => { if (String(data).includes('Ready')) { clearTimeout(timer); resolve(); } });
  frontend.stderr.on('data', data => { if (String(data).includes('EADDRINUSE')) { clearTimeout(timer); reject(new Error('Frontend port is already in use')); } });
  frontend.on('exit', code => { clearTimeout(timer); reject(new Error(`Frontend exited: ${code}`)); });
});
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', api);
  await page.routeWebSocket(/\/ws$/, socket => {
    if (simulateDisconnect) { socket.close(); return; }
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw)); sent.push(message);
      if (message.kind === 'input_response') broadcast({ kind: 'event', event: { ...liveRuns[3].events[0], id: 'response-1', timestamp: new Date().toISOString(), type: 'input_response', payload: { requestId: 'request-1', answers: message.answers } } });
    });
    socket.send(JSON.stringify({ kind: 'hello', providers, activeRuns: liveRuns }));
  });
  await page.goto(`${base}/agents?workspace=1`);
  await page.getByRole('heading', { name: 'Agent constellation', exact: true }).waitFor();
  const rail = page.getByRole('region', { name: 'Live fleet across all workspaces' });
  const canvas = page.locator('.fleet-canvas');
  await canvas.getByText('Release train / Shell', { exact: true }).first().waitFor();
  assert.equal(await canvas.locator('.fleet-mission').count(), 4, 'each concurrent run has its own node');
  assert.equal(await rail.locator('.fleet-run').count(), 3);
  await rail.getByRole('button', { name: 'Show all 4 agents' }).click();
  assert.equal(await rail.locator('.fleet-run').count(), 4);
  assert.match(await rail.locator('[data-run-id="pipeline-run"]').innerText(), /codex-actual-run-model/);
  assert.doesNotMatch(await rail.locator('[data-run-id="pipeline-run"]').innerText(), /configured-default/);
  assert.match(await rail.innerText(), /12:34/);
  assert.match(await rail.locator('[data-run-id="waiting-run"]').innerText(), /waiting 01:14/);
  assert.equal(await rail.locator('[data-run-id="pipeline-run"]').getByRole('link', { name: 'Open pipeline' }).getAttribute('href'), '/pipeline/7?workspace=1&suite=11');
  assert.equal(await rail.locator('[data-run-id="custom-run"]').getByRole('link', { name: 'Open session' }).getAttribute('href'), '/?workspace=2&thread=thread-custom');
  await canvas.getByRole('region', { name: 'Queued work' }).getByText('Verify release', { exact: true }).waitFor();
  assert.match(await canvas.getByRole('region', { name: 'Queued work' }).innerText(), /scoped-grok-model/);
  assert.equal(await canvas.getByRole('region', { name: 'Standby agents' }).getByText('GitHub Copilot', { exact: true }).count(), 1);
  assert.equal(await canvas.getByRole('region', { name: 'Unavailable agents' }).getByText('Disabled', { exact: true }).count(), 1);

  // Timers advance from server events, and independently identify each same-provider run.
  broadcast({ kind: 'event', event: { id: 'tick', runId: 'pipeline-run', provider: 'codex', model: liveRuns[0].model, timestamp: new Date().toISOString(), type: 'status', payload: { state: 'running', elapsedMs: 755000, usage: null } } });
  await rail.locator('[data-run-id="pipeline-run"]').getByText('12:35', { exact: true }).waitFor();
  assert.equal(await rail.locator('[data-run-id="consult-run"]').getByText('12:34', { exact: true }).count(), 1);
  await rail.getByRole('button', { name: 'Answer request', exact: true }).click();
  await rail.getByRole('radio', { name: 'Existing schema' }).click();
  await rail.getByRole('button', { name: /Send answers/ }).click();
  await rail.locator('.fleet-inline-decision').waitFor({ state: 'hidden' });
  assert.ok(sent.some(message => message.kind === 'input_response' && message.runId === 'waiting-run' && message.answers.q1 === 'existing'));
  await rail.getByRole('button', { name: 'Stop Codex CLI: Review architecture' }).click();
  assert.ok(sent.some(message => message.kind === 'interrupt' && message.runId === 'consult-run'));

  // Status, workspace and provider filters do not change the global fleet scope.
  await canvas.getByRole('combobox', { name: /^Workspace/ }).selectOption('2');
  assert.equal(await canvas.locator('.fleet-mission').count(), 2);
  assert.equal(await rail.locator('.fleet-run').count(), 4);
  await canvas.getByRole('combobox', { name: /^Workspace/ }).selectOption('all');
  await page.getByRole('navigation', { name: 'Agent fleet', exact: true }).getByRole('button', { name: /Codex CLI/ }).click();
  assert.equal(await canvas.locator('.fleet-mission').count(), 2);
  await canvas.getByRole('button', { name: 'Clear provider filter' }).click();
  await canvas.getByRole('combobox', { name: /^Status/ }).selectOption('queued');
  assert.equal(await canvas.locator('.fleet-mission').count(), 0);
  await canvas.getByRole('combobox', { name: /^Status/ }).selectOption('all');
  await canvas.getByRole('button', { name: '☷ List', exact: true }).click();
  assert.equal(await canvas.locator('.fleet-list .fleet-mission').count(), 4);
  await canvas.getByRole('button', { name: '◇ Graph', exact: true }).click();

  // Provider management remains available and tab navigation retains the live rail.
  await page.getByRole('link', { name: 'Configuration', exact: true }).click();
  await page.getByRole('button', { name: 'Re-detect', exact: true }).waitFor();
  assert.equal(await rail.locator('.fleet-run').count(), 4);
  await page.getByRole('link', { name: 'Live fleet', exact: true }).click();
  await canvas.waitFor();
  for (const width of [1440, 1024, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const theme of ['midnight', 'deep', 'daylight']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.waitForTimeout(180); // Let theme color transitions settle before capturing.
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow: ${width}, ${theme}`);
      assert.ok(await canvas.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `canvas overflow: ${width}, ${theme}`);
      if (await page.locator('.app-sidebar-toggle').isVisible()) {
        const toggle = await page.locator('.app-sidebar-toggle').boundingBox();
        const title = await rail.locator('.live-fleet-title').boundingBox();
        assert.ok(title.x >= toggle.x + toggle.width, `navigation overlaps the fleet title at ${width}px`);
      }
      await page.screenshot({ path: join(output, `fleet-${width}-${theme}.png`), fullPage: true });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await canvas.locator('.fleet-mission-edge span').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.setViewportSize({ width: 1440, height: 1050 });

  // Metadata failure is visible, while the live socket feed stays usable.
  metadataError = true;
  await page.getByRole('button', { name: 'Refresh fleet', exact: true }).click();
  await canvas.getByRole('alert').waitFor();
  assert.equal(await rail.locator('.fleet-run').count(), 4);
  metadataError = false;
  await canvas.getByRole('button', { name: 'Retry', exact: true }).click();
  await canvas.getByRole('alert').waitFor({ state: 'hidden' });

  // Disconnect freezes clocks and disables controls; replay settles removals.
  simulateDisconnect = true;
  for (const socket of sockets) socket.close();
  await rail.getByText(/Reconnecting/).first().waitFor();
  await page.waitForFunction(() => document.querySelector('.live-fleet button[aria-label="Stop Codex CLI: Build API"]')?.disabled);
  liveRuns = [];
  simulateDisconnect = false;
  await rail.getByText('0 running', { exact: true }).waitFor();
  await canvas.getByRole('heading', { name: 'The fleet is standing by' }).waitFor();
  assert.equal(await canvas.locator('.fleet-inspector').count(), 0);
  assert.deepEqual(errors, []);
  console.log(`PASS fleet: concurrent runs, actual models, server timers, waiting duration, exact ownership, inline decisions, Stop isolation, filters, graph/list, configuration, queue/standby/disabled, metadata recovery, reconnect replay, five widths and three themes. Screenshots: ${output}`);
  for (const [flag, script] of [['--activity', 'verify-activity-layout-browser.mjs'], ['--shell', 'verify-shell-browser.mjs']]) if (process.argv.includes(flag)) await new Promise((resolve, reject) => {
    const check = spawn(process.execPath, [`scripts/${script}`], { stdio: 'inherit', env: { ...process.env, SHELL_BASE_URL: base } });
    check.on('exit', code => code === 0 ? resolve() : reject(new Error(`${script} failed: ${code}`)));
    check.on('error', reject);
  });
} finally { await browser.close(); frontend?.kill(); }
