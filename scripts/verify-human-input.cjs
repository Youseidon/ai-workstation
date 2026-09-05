// Read the live UI; intercept every write so this check never starts a real agent.
// node scripts/verify-human-input.cjs --playwright <module-path> --cdp <url>
//   --prompt <waiting-prompt-id> --pipeline <pipeline-id> --artifacts <directory>
const assert = require('node:assert/strict');
const { parseArgs } = require('node:util');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { values } = parseArgs({ options: Object.fromEntries(['playwright', 'cdp', 'url', 'api', 'prompt', 'pipeline', 'artifacts'].map(name => [name, { type: 'string' }])) });
const { chromium } = require(values.playwright || 'playwright');
const url = values.url || 'http://localhost:3000';
const api = values.api || 'http://127.0.0.1:4000';
const promptId = Number(values.prompt);
const pipelineId = Number(values.pipeline);
assert(Number.isSafeInteger(promptId) && promptId > 0, '--prompt is required');
assert(Number.isSafeInteger(pipelineId) && pipelineId > 0, '--pipeline is required');

(async () => {
  const browser = await chromium.connectOverCDP(values.cdp || 'http://127.0.0.1:9227');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const original = await (await context.request.get(`${api}/api/prompts/${promptId}/activity`)).json();
  assert.equal(original.item.operationalState, 'AWAITING_RESPONSE', 'fixture must need input');
  let activity = structuredClone(original);
  let writes = [];
  let mockActivity = false;
  await context.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      if (mockActivity && path === `/api/prompts/${promptId}/activity`) return route.fulfill({ json: activity, headers: { 'Access-Control-Allow-Origin': '*' } });
      return route.continue();
    }
    if (request.method() === 'OPTIONS') return route.continue();
    const body = request.postDataJSON();
    writes.push({ path, body });
    if (path === `/api/prompts/${promptId}/clarify`) {
      mockActivity = true;
      activity.clarifications.push({ id: 999999, promptId, question: body.question, answer: 'A domain or an organization name is sufficient.', provider: 'claude', model: null, state: 'DONE', createdAt: new Date().toISOString(), answeredAt: new Date().toISOString() });
      return route.fulfill({ json: { runId: 'mock-clarification' }, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (path === `/api/prompts/${promptId}/respond-and-continue`) {
      mockActivity = true;
      if (body.responseId) return route.fulfill({ json: { responseId: body.responseId, started: true, runId: 'mock-successor' }, headers: { 'Access-Control-Allow-Origin': '*' } });
      activity.item.operationalState = 'READY';
      activity.item.prompt.status = 'TODO';
      activity.remarks.unshift({ id: 999998, promptId, kind: 'HUMAN_RESPONSE', content: body.content, actorType: 'USER', createdAt: new Date().toISOString(), runId: null });
      return route.fulfill({ json: { responseId: 999998, started: false, runId: null, error: 'Agent temporarily unavailable (simulated).' }, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    return route.abort('blockedbyclient');
  });
  const dialog = () => page.getByRole('dialog');
  const checkText = async (locator, text) => { await locator.getByText(text, { exact: true }).waitFor(); };
  try {
    await page.goto(`${url}/pipeline?workspace=${original.item.workspace.id}&pipeline=${pipelineId}`);
    await page.getByRole('button', { name: 'Review and respond', exact: true }).first().click();
    await dialog().getByLabel('Your answer', { exact: true }).fill('Draft: use the supplied directory.');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Review and respond', exact: true }).first().click();
    assert.equal(await dialog().getByLabel('Your answer', { exact: true }).inputValue(), 'Draft: use the supplied directory.');
    await dialog().getByRole('button', { name: 'Ask for clarification', exact: true }).click();
    await dialog().getByLabel('Your clarification question', { exact: true }).fill('Do you need domains or names?');
    await dialog().getByRole('button', { name: 'Ask agent', exact: true }).click();
    await checkText(dialog(), 'A domain or an organization name is sufficient.');
    await dialog().getByRole('button', { name: 'Change instructions', exact: true }).click();
    await dialog().getByLabel('Revised instructions', { exact: true }).fill('Use only the directory I supplied; do not discover new organizations.');
    if (values.artifacts) { mkdirSync(values.artifacts, { recursive: true }); await page.screenshot({ path: join(values.artifacts, 'human-input-desktop.png') }); }
    await dialog().getByRole('button', { name: 'Apply instructions and continue', exact: true }).click();
    await checkText(dialog(), 'Your answer is saved.');
    await checkText(dialog(), 'Agent temporarily unavailable (simulated).');
    await dialog().getByRole('button', { name: 'Continue with saved answer', exact: true }).click();
    await checkText(dialog(), 'Answer saved. Pipeline continuation started.');
    assert.equal(writes.length, 3);
    assert.match(writes[1].body.content, /^Updated instructions from the owner/);
    assert.equal(writes[2].body.responseId, 999998);
    assert.equal(writes[2].body.content, undefined);

    mockActivity = false;
    await page.goto(`${url}/tasks?workspace=${original.item.workspace.id}&prompt=${promptId}`);
    await page.getByRole('button', { name: /Needs you [1-9]/ }).click();
    await page.getByRole('button', { name: 'Review and respond', exact: true }).first().click();
    await dialog().getByLabel('Your answer', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await dialog().isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await dialog().getByLabel('Your answer', { exact: true }).fill('Mobile draft');
    if (values.artifacts) await page.screenshot({ path: join(values.artifacts, 'human-input-mobile.png') });
    await page.keyboard.press('Escape');
    assert.equal(await dialog().count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: pipeline and Tasks entry points, attention filter, draft persistence, clarification history, changed instructions, saved-answer failure/retry, mobile layout, Escape dismissal, no browser exceptions. All writes intercepted.');
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
