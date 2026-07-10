/*
 * Captures every frame of the README demo GIF and writes the PNGs into OUT.
 * Driven entirely by env so build.sh owns the server + git setup:
 *
 *   PW_MODULE     file:// URL of Playwright's index.js (build.sh discovers it)
 *   OUT           working dir holding the *.html templates; PNGs are written here
 *   BASE          running server, e.g. http://127.0.0.1:8791
 *   DIFF_URLPATH  URL path of a git-changed, previewable file, e.g. /uploadserver_preview/gitinfo.py
 *
 * Produces: term-00..14, d-{markdown,code,config,diff}, mobile-1, mobile-2
 * (plus the intermediate raw app + phone screenshots they are built from).
 */
const pw = await import(process.env.PW_MODULE);
const chromium = pw.chromium ?? pw.default?.chromium;

const OUT = process.env.OUT;
const BASE = process.env.BASE;
const DIFF = process.env.DIFF_URLPATH || '/uploadserver_preview/gitinfo.py';
const fileUrl = (name) => 'file://' + OUT + '/' + name;

const browser = await chromium.launch();

/* ---------- desktop context (also renders the local HTML templates) ---------- */
const desktop = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
const dp = await desktop.newPage();
const settle = async (page, ms = 1300) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
};
const waitRender = (page, sel) =>
  page.waitForSelector(sel, { timeout: 8000 }).catch(() => {});

async function openDiff(page) {
  const btn = page.locator('#btn-diff');
  await btn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  await btn.click().catch(() => {});
  await waitRender(page, '.content .d2h-wrapper, .content .d2h-file-wrapper');
}

/* 1. raw app screenshots (full-bleed) that the framed frames are built from */
async function appShot(name, urlPath, ready, diff = false) {
  await dp.goto(BASE + urlPath, { waitUntil: 'load' });
  if (ready) await waitRender(dp, ready);
  await settle(dp);
  if (diff) await openDiff(dp);
  await dp.screenshot({ path: `${OUT}/${name}` });
  console.log('app:', name);
}
await appShot('01-markdown.png', '/README.md', '.content .markdown-body, .content .md');
await appShot('02-code.png', '/uploadserver_preview/__init__.py', '.content pre code, .content .hljs');
await appShot('03-config.png', '/pyproject.toml', '.content pre code, .content .hljs');
await appShot('04-gitdiff.png', DIFF, null, true);

/* 2. terminal typing frames (caption + prompt live in terminal.html) */
{
  await dp.goto(fileUrl('terminal.html'), { waitUntil: 'load' });
  await dp.waitForTimeout(200);
  let i = 0;
  const shot = async () => {
    await dp.screenshot({ path: `${OUT}/term-${String(i).padStart(2, '0')}.png` });
    i++;
  };
  await dp.evaluate(() => window.setState(0, false, true)); await shot();
  for (let n = 2; n <= 24; n += 2) {
    await dp.evaluate((n) => window.setState(n, false, true), n); await shot();
  }
  await dp.evaluate(() => window.setState(24, false, true)); await shot();   // hold full command
  await dp.evaluate(() => window.setState(24, true, false)); await shot();   // server output
  console.log('terminal frames:', i);
}

/* 3. framed desktop frames (screenshot inside a card + caption) */
async function frame(out, caption, src) {
  const url = `${fileUrl('desktop.html')}?caption=${encodeURIComponent(caption)}&src=${encodeURIComponent(src)}`;
  await dp.goto(url, { waitUntil: 'load' });
  await dp.waitForTimeout(400);
  await dp.screenshot({ path: `${OUT}/${out}` });
  console.log('framed:', out);
}
await frame('d-markdown.png', '<b>Markdown</b>, rendered', '01-markdown.png');
await frame('d-code.png', '<b>Code</b>, syntax-highlighted', '02-code.png');
await frame('d-config.png', '<b>Config &amp; data</b> files', '03-config.png');
await frame('d-diff.png', '<b>Git diffs</b> vs your branch', '04-gitdiff.png');

/* ---------- mobile context (real iPhone-ish viewport) ---------- */
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const mp = await mobile.newPage();

// explorer with the nav sheet open
await mp.goto(`${BASE}/`, { waitUntil: 'load' });
await settle(mp, 600);
await mp.click('#nav-toggle').catch(() => {});
await mp.waitForTimeout(700);
await mp.screenshot({ path: `${OUT}/m-explorer.png` });
console.log('mobile: explorer');

async function mShot(name, urlPath, ready, diff = false) {
  await mp.goto(BASE + urlPath, { waitUntil: 'load' });
  if (ready) await waitRender(mp, ready);
  await settle(mp);
  if (diff) await openDiff(mp);
  await mp.screenshot({ path: `${OUT}/${name}` });
  console.log('mobile:', name);
}
await mShot('m-markdown.png', '/README.md', '.content .markdown-body, .content .md');
await mShot('m-code.png', '/uploadserver_preview/__init__.py', '.content pre code, .content .hljs');
await mShot('m-diff.png', DIFF, null, true);

/* 4. composite the phones into two landscape frames (desktop context) */
async function showcase(out, caption, phones) {
  const url = `${fileUrl('showcase.html')}?caption=${encodeURIComponent(caption)}&phones=${encodeURIComponent(phones)}`;
  await dp.goto(url, { waitUntil: 'load' });
  await dp.waitForTimeout(500);
  await dp.screenshot({ path: `${OUT}/${out}` });
  console.log('showcase:', out);
}
await showcase(
  'mobile-1.png',
  'Works on mobile <span class="sub">— the sidebar folds into a sheet</span>',
  'm-explorer.png|<b>Explorer</b> sheet;m-markdown.png|<b>Markdown</b> rendered'
);
await showcase(
  'mobile-2.png',
  'Same previews, one hand <span class="sub">— code &amp; git diffs</span>',
  'm-code.png|<b>Syntax</b> highlighting;m-diff.png|<b>Git diff</b> view'
);

await browser.close();
console.log('capture done');
