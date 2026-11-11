// Render the Chrome Web Store screenshots, the small promo tile and the README
// images from the test fixture (never from third-party sites).
//
//   node scripts/screenshots.mjs                 -> store/screenshots/*.png, store/promo-440x280.png
//   CHROME=/path/to/chrome node scripts/screenshots.mjs
//
// Uses the same launcher as the e2e tests (Chrome for Testing / Chromium,
// dark color scheme, extension loaded through CDP).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, findChrome } from '../test/e2e/harness.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(repo, 'test/fixtures');
const outDir = path.join(repo, 'store/screenshots');
fs.mkdirSync(outDir, { recursive: true });

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
function serve(port) {
  const server = http.createServer((req, res) => {
    const file = path.join(fixtures, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(fixtures) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const W = 1280;
const H = 800;
const servers = [await serve(4810), await serve(4811)];
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-shots-'));
const { context, sw, extensionId } = await launchWithExtension({ chromePath: process.env.CHROME || findChrome(), userDataDir, repo });
const extOrigin = `chrome-extension://${extensionId}`;

const configure = (patch) =>
  sw.evaluate(async (p) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...p } });
  }, patch);
const tabIdOf = (url) => sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);

const page = await context.newPage();
await page.setViewportSize({ width: W, height: H });
await page.emulateMedia({ colorScheme: 'dark' });
const fixture = 'http://127.0.0.1:4810/light.html';

async function settle(ms = 1500) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}
const png = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

// 1. Original and adapted renders of the same viewport.
await configure({ mode: 'off' });
await page.goto(fixture);
await settle();
const before = await page.screenshot();
await configure({ mode: 'system', scope: 'all', sites: {}, dismissed: {} });
await page.reload();
await settle(2500);
const after = await page.screenshot();

// 2. The popup, rendered for the fixture tab.
const tabId = await tabIdOf(fixture);
const popup = await context.newPage();
await popup.setViewportSize({ width: 344, height: 640 });
await popup.emulateMedia({ colorScheme: 'dark' });
await popup.goto(`${extOrigin}/src/popup/popup.html?tab=${tabId}`);
await popup.waitForTimeout(800);
const popupShot = await popup.locator('body').screenshot();
await popup.close();

// 3. The "Try" offer on a bright page (default settings: ask per site).
await configure({ scope: 'ask', sites: {}, dismissed: {} });
await page.goto(fixture);
await settle(2500);
const offer = await page.screenshot();

// Compose the store screenshots in a scratch page.
await configure({ mode: 'off' }); // the composition page itself must not be adapted
const comp = await context.newPage();
await comp.setViewportSize({ width: W, height: H });
// Single quotes only: this string is placed inside style="..." attributes.
const font = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif`;
const label = (text, left) =>
  `<div style="position:absolute;bottom:20px;left:${left}px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;font:600 14px ${font};
     background:rgba(0,0,0,.72);color:#fff;letter-spacing:.2px;backdrop-filter:blur(6px)">${text}</div>`;

async function compose(name, html, size = { width: W, height: H }) {
  await comp.setViewportSize(size);
  await comp.setContent(`<!doctype html><html><body style="margin:0;width:${size.width}px;height:${size.height}px;overflow:hidden;position:relative">${html}</body></html>`);
  await comp.waitForTimeout(200);
  const file = path.join(name.startsWith('promo') ? path.join(repo, 'store') : outDir, `${name}.png`);
  await comp.screenshot({ path: file });
  console.log(path.relative(repo, file));
}

// The left half of the page, original and adapted, side by side.
const half = (img, left) =>
  `<div style="position:absolute;top:0;left:${left}px;width:640px;height:800px;background:url(${png(img)}) 0 0/1280px auto no-repeat"></div>`;
await compose(
  '1-before-after',
  `${half(before, 0)}${half(after, 640)}
   <div style="position:absolute;top:0;bottom:0;left:639px;width:2px;background:#fff;box-shadow:0 0 12px rgba(0,0,0,.5)"></div>
   ${label('Original', 320)}${label('Adaptive Dark Mode', 960)}`,
);
await compose('2-adapted', `<img src="${png(after)}" style="position:absolute;inset:0">`);
await compose(
  '3-popup',
  `<img src="${png(after)}" style="position:absolute;inset:0;filter:brightness(.55)">
   <img src="${png(popupShot)}" style="position:absolute;top:12px;right:16px;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08)">`,
);
await compose('4-try-offer', `<img src="${png(offer)}" style="position:absolute;inset:0">`);

// Small promo tile (440x280): one card of the fixture, original on the left
// and adapted on the right, above the name.
const icon = fs.readFileSync(path.join(repo, 'icons/icon128.png'));
// Source region x 30.., y 470.. (the "Additional options" card) at 0.7 scale.
const crop = (img) => `background:#111 url(${png(img)}) -21px -329px/896px auto no-repeat`;
await compose(
  'promo-440x280',
  `<div style="position:absolute;left:0;top:0;width:219px;height:186px;${crop(before)}"></div>
   <div style="position:absolute;left:221px;top:0;width:219px;height:186px;${crop(after)}"></div>
   <div style="position:absolute;top:0;height:186px;left:219px;width:2px;background:#fff;box-shadow:0 0 10px rgba(0,0,0,.5)"></div>
   <div style="position:absolute;left:0;right:0;top:186px;bottom:0;background:#141416;display:flex;align-items:center;gap:12px;justify-content:center">
     <img src="${png(icon)}" style="width:52px;height:52px">
     <div style="font:700 26px ${font};color:#fff;letter-spacing:-.3px">Adaptive Dark Mode</div>
   </div>`,
  { width: 440, height: 280 },
);

await context.close();
for (const s of servers) s.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
