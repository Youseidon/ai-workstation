// Uses the production frontend and mocked agent data; optionally run through
// verify-fleet-browser.mjs --start --activity to manage the frontend lifecycle.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtures, launchBrowser } from './lib/shellFixtures.mjs';

const base = process.env.SHELL_BASE_URL ?? 'http://127.0.0.1:3917';
const output = await mkdtemp(join(tmpdir(), 'activity-layout-'));
const fixtures = createFixtures();
const textEvent = (runId, text) => ({ id: `text-${runId}`, runId, provider: 'codex', model: 'actual-model', timestamp: fixtures.now, type: 'assistant_text', payload: { blockId: `block-${runId}`, delta: true, text, kind: 'message' } });
fixtures.sessions[0].model = 'actual-model';
fixtures.sessions[0].events = [textEvent('run-a', 'Agent log visible immediately. The implementation is complete and all checks passed.')];
fixtures.sessions[0].changes = { ...fixtures.changes[0], filesChanged: 2 };
const live = ['live-unlisted', 'live-consult'].map((runId, index) => ({ runId, provider: 'codex', model: 'actual-live-model', role: index ? 'consult' : 'execute', state: 'running', elapsedMs: 123000, startedAt: fixtures.now, workspace: fixtures.workspaces[0], source: { type: 'custom', displayText: index ? 'Review the implementation' : 'Live task before history refresh', title: index ? 'Review the implementation' : 'Live task before history refresh', threadId: `thread-${runId}` }, usage: null, detail: null, permissionMode: null, truncated: false, events: [textEvent(runId, `Streaming output from ${runId}, before it appears in the history list.`)] }));
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', fixtures.api);
  await page.routeWebSocket(/\/ws$/, socket => socket.send(JSON.stringify({ kind: 'hello', providers: [], activeRuns: live })));
  await page.goto(`${base}/activity?workspace=1&run=run-a`);
  const activity = page.getByRole('region', { name: 'Selected activity', exact: true });
  const logs = activity.getByRole('region', { name: 'Agent logs', exact: true });
  const details = activity.locator('details.activity-session-details');
  await logs.locator('.assistant-content').getByText(/Agent log visible immediately/).waitFor();
  assert.equal(await details.evaluate(el => el.open), false);
  await activity.getByRole('link', { name: 'Review changes' }).waitFor();
  assert.equal(await activity.getByRole('link', { name: 'Open in Chat' }).getAttribute('href'), '/?workspace=1');
  for (const width of [1440, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['midnight', 'deep', 'daylight']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.waitForTimeout(180);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px in ${theme}`);
      const bounds = await logs.boundingBox();
      assert.ok(bounds.y < 800 / 2, `logs start below the first glance at ${width}px: ${bounds.y}`);
      assert.ok(bounds.height >= 800 * .4, `logs do not occupy enough space at ${width}px: ${bounds.height}`);
      assert.ok(await logs.locator('.assistant-content').getByText(/Agent log visible immediately/).evaluate(el => {
        const box = el.getBoundingClientRect();
        return box.bottom > 0 && box.top < innerHeight;
      }), `agent output is below the viewport at ${width}px`);
      if (width === 1440) {
        const rows = await page.locator('.live-fleet-rows .fleet-run-inline').evaluateAll(els => els.map(el => { const box = el.getBoundingClientRect(); const style = getComputedStyle(el); return { y: box.y, bottom: box.bottom, height: box.height, background: style.backgroundColor }; }));
        assert.equal(rows.length, 2);
        assert.ok(rows.every(row => row.height <= 40 && row.background === 'rgba(0, 0, 0, 0)'), 'live agents should be compact inline rows');
        assert.ok(rows[1].y >= rows[0].bottom, 'the second agent belongs below the first');
      }
      await page.screenshot({ path: join(output, `activity-${width}-${theme}.png`) });
    }
  }
  await details.getByText('Session details', { exact: true }).click();
  assert.equal(await details.evaluate(el => el.open), true);
  await details.getByText('Working directory', { exact: true }).waitFor();
  await details.getByText('Est. cost', { exact: true }).waitFor();
  assert.ok((await logs.boundingBox()).height > 160, 'opening metadata preserves transcript space');
  await details.getByText('Session details', { exact: true }).click();

  // A newly announced live run renders immediately, even before /api/sessions contains it.
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.getByRole('navigation', { name: 'Conversations and runs', exact: true }).getByRole('link', { name: /Live task before history refresh/ }).click();
  await logs.locator('.assistant-content').getByText('Streaming output from live-unlisted, before it appears in the history list.', { exact: true }).waitFor();
  assert.equal(await details.evaluate(el => el.open), false);
  await logs.getByRole('button', { name: 'Conversation options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Execution log', exact: true }).click();
  await logs.locator('.chat-canvas:visible').getByText('Streaming output from live-unlisted, before it appears in the history list.', { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
  console.log(`PASS Activity layout: compact stacked live rows, transcript visible on entry at four widths in three themes, collapsed metadata with preserved details/actions, immediate unlisted live output, and execution-log access. Screenshots: ${output}`);
} finally { await browser.close(); }
