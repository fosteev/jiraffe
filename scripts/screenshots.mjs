// Скриншоты для README: снимает окно `#win` английского прототипа в docs/screenshots/<name>.png.
// Запуск: npm run screenshots (нужен Chrome; путь — CHROME_PATH).
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page_url = pathToFileURL(resolve(root, 'prototype/index.en.html')).href;
const outDir = resolve(root, 'docs/screenshots');
const executablePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Кадры: имя файла → действия над свежезагруженным прототипом. */
const frames = {
  card: async () => {},
  filters: async (p) => {
    await p.click('.seg button[data-m="jql"]');
    await p.click('#issues-acts [data-act="qp"]');
    await p.click('.qp-i[data-g="status"][data-v="prog"]');
    await p.click('.qp-i[data-g="type"][data-v="bug"]');
  },
  attachments: async (p) => { await p.click('.subtabs [data-s="att"]'); },
  'log-work': async (p) => {
    await p.click('#pane .hrow [data-act="log"]');
    await p.fill('#lg-c', 'Archive pagination: switch to the next_page_token cursor');
    await p.fill('#lg-tok', '231000');
  },
  'change-status': async (p) => { await p.click('#pane [data-act="status"]'); },
  epic: async (p) => { await p.click('#pane .crumbs [data-act="epic"]'); },
  release: async (p) => { await p.evaluate(() => window.__proto.openTab('rel', 'v214')); },
  tempo: async (p) => {
    for (const v of ['issues', 'filters', 'epics', 'rel']) await p.click(`.view-h[data-v="${v}"]`);
  },
};

const browser = await chromium.launch({ executablePath });
let failed = false;
try {
  await mkdir(outDir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US' });
  for (const [name, act] of Object.entries(frames)) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.goto(page_url);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await act(page);
    await page.waitForTimeout(150);
    if (errors.length) throw new Error(`${name}: pageerror — ${errors[0].message}`);
    await page.locator('#win').screenshot({ path: resolve(outDir, `${name}.png`), animations: 'disabled' });
    console.log(`docs/screenshots/${name}.png`);
    await page.close();
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
}
if (failed) process.exit(1);
