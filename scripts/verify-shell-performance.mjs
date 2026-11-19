// Large-fixture performance checks for the shared shell (the Chat 200-turn /
// 1,000-thread baseline lives in verify-chat-page-browser.mjs).
//
// Measures, per fixture: time until the content is visible, cumulative layout
// shift, and the cost of a scroll; and, across section navigation, that a
// section stops polling once you leave it.
//
//   (cd web && npx next start -p 3917) &
//   SHELL_BASE_URL=http://127.0.0.1:3917 node scripts/verify-shell-performance.mjs
import { createFixtures, launchBrowser } from './lib/shellFixtures.mjs';

const base = process.env.SHELL_BASE_URL ?? 'http://127.0.0.1:3917';
const LIMITS = { visibleMs: 4000, cls: 0.1, scrollMs: 50 };
const browser = await launchBrowser();
const results = [];
const failures = [];
const assert = (condition, message) => { if (!condition) failures.push(message); };

async function measure(name, route, ready, scroller, scale) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__cls += entry.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.route('**/api/**', createFixtures({ scale }).api);
  const started = Date.now();
  await page.goto(base + route);
  await page.locator(ready).first().waitFor({ timeout: 20000 });
  const visibleMs = Date.now() - started;
  await page.waitForTimeout(1000);
  const scrollMs = await page.locator(scroller).first().evaluate((el) => new Promise((resolve) => {
    const start = performance.now();
    el.scrollTop = el.scrollHeight / 2;
    el.dispatchEvent(new Event('scroll'));
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
  }));
  const cls = await page.evaluate(() => window.__cls);
  const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  results.push({ name, visibleMs, cls: Number(cls.toFixed(4)), scrollMs: Number(scrollMs.toFixed(1)), domNodes: nodes });
  assert(visibleMs < LIMITS.visibleMs, `${name}: visible after ${visibleMs}ms (limit ${LIMITS.visibleMs})`);
  assert(cls < LIMITS.cls, `${name}: layout shift ${cls.toFixed(3)} (limit ${LIMITS.cls})`);
  assert(scrollMs < LIMITS.scrollMs, `${name}: scroll took ${scrollMs.toFixed(1)}ms (limit ${LIMITS.scrollMs})`);
  assert(errors.length === 0, `${name}: page errors ${errors.join('; ')}`);
  await page.close();
}

await measure('Activity · 2,000 sessions', '/activity?workspace=1', 'nav[aria-label="Conversations and runs"] a', '.app-sidebar-collection', { sessions: 2000 });
await measure('Pipeline overview · 300 pipelines', '/pipeline?workspace=1', 'nav[aria-label="Pipelines"] a', '.app-route .overflow-auto', { pipelines: 300 });
await measure('Changes review · 400 files, 10,000-line diff', '/changes/run-a', 'section[aria-label="Diff"] pre', 'section[aria-label="Diff"]', { files: 400, diffLines: 10000 });

// Subscriptions across navigation: leaving a section stops its polling.
{
  const fixtures = createFixtures();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.clock.install();
  await page.route('**/api/**', fixtures.api);
  const count = (pattern, since) => fixtures.requests.filter((request) => request.at >= since && pattern.test(request.path)).length;
  const go = async (label) => {
    await page.getByRole('button', { name: /^Section: / }).click();
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: label }).click();
  };
  await page.goto(`${base}/?workspace=1`);
  await page.getByRole('textbox', { name: 'Prompt', exact: true }).waitFor();
  let mark = Date.now();
  await page.clock.runFor(31000);
  const chatPolls = count(/\/threads$/, mark);
  await go('Activity');
  await page.waitForURL(/\/activity/);
  await go('Report');
  await page.waitForURL(/\/report/);
  await page.waitForTimeout(300);
  mark = Date.now();
  await page.clock.runFor(65000);
  const threadPolls = count(/\/threads$/, mark), sessionPolls = count(/^\/api\/sessions$/, mark), changePolls = count(/^\/api\/changes$/, mark);
  results.push({ name: 'Polling on Report for 65s after visiting Chat and Activity', chatThreadPollsWhileOnChat: chatPolls, threadPolls, sessionPolls, changePolls });
  assert(chatPolls >= 1, 'Chat polls its thread summaries while it is on screen');
  assert(threadPolls === 0, `Chat's library kept polling after leaving Chat (${threadPolls} requests)`);
  assert(sessionPolls === 0, `Activity kept polling after leaving Activity (${sessionPolls} requests)`);
  assert(changePolls === 0, `Changes was fetched without visiting Changes (${changePolls} requests)`);
  await page.close();
}

await browser.close();
console.table(results);
if (failures.length > 0) { console.error(failures.join('\n')); process.exit(1); }
console.log(`PASS large Activity, Pipeline and diff fixtures within ${LIMITS.visibleMs}ms / CLS ${LIMITS.cls} / ${LIMITS.scrollMs}ms scroll, and sections stop polling when you leave them`);
