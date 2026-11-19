// Screenshots of every route and page state in the shared shell, in all three
// themes at desktop and phone width, with a contact sheet for review. Each
// capture also asserts the shell contract, so a broken state fails the run.
//
//   (cd web && npx next start -p 3917) &
//   SHELL_BASE_URL=http://127.0.0.1:3917 node scripts/capture-shell-screenshots.mjs
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtures, launchBrowser } from './lib/shellFixtures.mjs';

const base = process.env.SHELL_BASE_URL ?? 'http://127.0.0.1:3917';
const output = process.env.SHELL_SCREENSHOT_DIR ?? await mkdtemp(join(tmpdir(), 'shell-screens-'));
const themes = ['midnight', 'deep', 'daylight'];
const widths = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone', width: 375, height: 760 }];
// [label, route, fixture mode, wait (ms)]
const shots = [
  ['Chat', '/?workspace=1', 'normal'],
  ['Pipeline overview', '/pipeline?workspace=1', 'normal'],
  ['Pipeline detail', '/pipeline/7?workspace=1', 'normal'],
  ['Pipeline editor', '/pipeline/7?workspace=1&edit=1', 'normal'],
  ['New pipeline', '/pipeline/new?workspace=1', 'normal'],
  ['Suite (missing)', '/pipeline/suite/11?workspace=1', 'normal'],
  ['Activity', '/activity?workspace=1&run=run-a', 'normal'],
  ['Changes', '/changes?workspace=1', 'normal'],
  ['Changes review', '/changes/run-a?file=web%2Fapp%2Fpage.tsx', 'normal'],
  ['Report', '/report?workspace=1', 'normal'],
  ['Agents', '/agents', 'normal'],
  ['Workspaces', '/workspaces?workspace=1', 'normal'],
  ['Activity · empty', '/activity?workspace=1', 'empty'],
  ['Changes · empty', '/changes?workspace=1', 'empty'],
  ['Pipeline · empty', '/pipeline?workspace=1', 'empty'],
  ['Report · empty', '/report?workspace=1', 'empty'],
  ['Activity · error', '/activity?workspace=1', 'error'],
  ['Changes · error', '/changes?workspace=1', 'error'],
  ['Pipeline · error', '/pipeline?workspace=1', 'error'],
  ['Report · error', '/report?workspace=1', 'error'],
  ['Changes review · loading', '/changes/run-a', 'loading'],
  ['Pipeline · loading', '/pipeline?workspace=1', 'loading'],
  ['Report · loading', '/report?workspace=1', 'loading'],
  ['Invalid pipeline id', '/pipeline/abc', 'normal'],
  ['Not found', '/no-such-page', 'normal'],
];

const browser = await launchBrowser();
const failures = [];
const entries = [];
for (const [label, route, mode] of shots) {
  for (const size of widths) {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', createFixtures({ mode }).api);
    await page.goto(base + route);
    await page.waitForTimeout(mode === 'loading' ? 900 : 1300);
    for (const theme of themes) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.waitForTimeout(60);
      const file = `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${size.name}-${theme}.png`;
      await page.screenshot({ path: join(output, file) });
      const check = await page.evaluate(() => ({
        mains: document.querySelectorAll('main').length,
        sidebars: document.querySelectorAll('aside.app-sidebar').length,
        heading: [...document.querySelectorAll('h1')].some((h) => h.textContent.trim() !== ''),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      const problems = [];
      if (check.mains !== 1) problems.push(`${check.mains} main landmarks`);
      if (check.sidebars !== 1) problems.push(`${check.sidebars} sidebars`);
      if (!check.heading) problems.push('no page title');
      if (check.overflow) problems.push('horizontal overflow');
      if (errors.length > 0) problems.push(`page errors: ${errors.join('; ')}`);
      if (problems.length > 0) failures.push(`${label} · ${size.name} · ${theme}: ${problems.join(', ')}`);
      entries.push({ label, size: size.name, theme, file, problems });
    }
    await page.close();
  }
}
await browser.close();

const card = (entry) => `<figure${entry.problems.length ? ' class="bad"' : ''}><img loading="lazy" src="${entry.file}" alt=""><figcaption>${entry.label} · ${entry.size} · ${entry.theme}${entry.problems.length ? ` — ${entry.problems.join(', ')}` : ''}</figcaption></figure>`;
await writeFile(join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Shell screenshots</title><style>body{font:14px system-ui;margin:16px;background:#111;color:#eee}section{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}figure{margin:0}img{width:100%;border:1px solid #333}.bad figcaption{color:#f77}</style><h1>Shell screenshots (${entries.length})</h1><section>${entries.map(card).join('')}</section>`);
console.log(`${entries.length} screenshots, contact sheet: ${join(output, 'index.html')}`);
if (failures.length > 0) { console.error(failures.join('\n')); process.exit(1); }
console.log('PASS every route and state keeps one shell, a title and no overflow in all themes at desktop and phone width');
