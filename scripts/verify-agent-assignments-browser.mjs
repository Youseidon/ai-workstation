import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from './lib/shellFixtures.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'agent-assignments-browser-'));
const bundlePath = join(output, 'harness.js');
await build({ entryPoints: [`${repo}/web/test/browser/agentAssignments.browser.tsx`], outfile: bundlePath, bundle: true, jsx: 'automatic', tsconfig: `${repo}/web/tsconfig.json` });
const bundle = await readFile(bundlePath, 'utf8');
const { compile } = await import(`${repo}/node_modules/@tailwindcss/node/dist/index.mjs`);
const compiler = await compile(await readFile(`${repo}/web/app/globals.css`, 'utf8'), { base: `${repo}/web/app`, onDependency() {} });
const candidates = [...bundle.matchAll(/"([^"\n]{1,500})"/g)].flatMap(m => m[1].split(/\s+/)).filter(c => /^[\w:[\]#()./%!-]+$/.test(c));
const htmlPath = join(output, 'harness.html');
await writeFile(htmlPath, `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${compiler.build(candidates)} body{margin:0;background:var(--color-surface-0);color:var(--color-fg);font-family:Arial}</style></head><body><div id="root"></div><script>${bundle.replaceAll('</script', '<\\/script')}</script></body></html>`);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(htmlPath).href);
  const toggle = page.getByRole('switch', { name: 'Automatically reassign agents' });
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  // One picker everywhere: provider chips; the active chip opens the model menu.
  const suite = page.getByRole('group', { name: 'Suite agent', exact: true });
  await suite.getByRole('button', { name: /^claude/ }).click();
  await page.getByRole('option', { name: /claude model/ }).click();
  assert.equal(await suite.getByRole('button', { name: /^claude/ }).getAttribute('aria-pressed'), 'true');
  assert.match(await suite.getByRole('button', { name: /^claude/ }).textContent(), /claude model/);
  const p2 = page.getByRole('group', { name: 'Agent for P2', exact: true });
  assert.equal(await p2.getByRole('button', { name: /Suite agent/ }).getAttribute('aria-pressed'), 'true');
  await p2.getByRole('button', { name: /^codex/ }).click();
  await page.getByRole('option', { name: /codex model/ }).click();
  assert.equal(await p2.getByRole('button', { name: /^codex/ }).getAttribute('aria-pressed'), 'true');
  const p3 = page.getByRole('group', { name: 'Agent for P3', exact: true });
  await p3.getByRole('button', { name: /^codex/ }).click();
  await page.keyboard.press('Escape');
  await p3.getByRole('button', { name: /Follow parent/ }).click();
  assert.equal(await p3.getByRole('button', { name: /Follow parent/ }).getAttribute('aria-pressed'), 'true');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  const fallbacks = page.getByRole('group', { name: 'Suite fallback order', exact: true });
  await fallbacks.getByRole('button', { name: /^codex/ }).click();
  assert.equal(await fallbacks.getByRole('button', { name: /^codex/ }).getAttribute('aria-pressed'), 'true');
  assert.match(await fallbacks.getByRole('button', { name: /^codex/ }).textContent(), /1/);
  await page.getByRole('button', { name: 'Use suite agent for all prompts' }).click();
  assert.equal(await p2.getByRole('button', { name: /Suite agent/ }).getAttribute('aria-pressed'), 'true');
  assert.match(await suite.getByRole('button', { name: /^claude/ }).textContent(), /claude model/);
  await page.getByRole('button', { name: 'P1', exact: true }).click();
  assert.equal(await page.getByLabel('Configured prompt').textContent(), '1');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow at ${width}px`);
    await page.screenshot({ path: join(output, `assignments-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(`Agent assignment controls passed at desktop and mobile widths. Screenshots: ${output}`);
} finally { await browser.close(); }
