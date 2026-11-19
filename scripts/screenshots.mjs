// Render the Chrome Web Store screenshots and the promo tiles.
//
//   node scripts/screenshots.mjs                 -> store/screenshots/*.png, store/promo-440x280.png,
//                                                   store/promo-marquee-1400x560.png
//   CHROME=/path/to/chrome node scripts/screenshots.mjs
//
// The pages are the three demo sites in store/demo/ (a product site, a
// magazine and a recipe site: invented names, original copy, AI-generated
// photographs), served as tidewell.example, fernway.example and
// larder.example. Never third-party sites.
//
// Uses the same launcher as the e2e tests (Chrome for Testing / Chromium,
// dark color scheme, extension loaded through CDP). Every picture of a page,
// the popup and the offer card is a real capture of the extension at work,
// taken at 2x through CDP and placed in a drawn browser window. The script
// refuses to save an image whose page isn't in the state the caption claims.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, findChrome } from '../test/e2e/harness.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoDir = path.join(repo, 'store/demo');
const outDir = path.join(repo, 'store/screenshots');
fs.mkdirSync(outDir, { recursive: true });

// --- demo server: <site>.example:PORT/ -> store/demo/<site>/ ----------------------
const PORT = 4820;
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const site = String(req.headers.host || '').split('.')[0];
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(demoDir, site, p);
  if (!file.startsWith(demoDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
const url = (site) => `http://${site}.example:${PORT}/`;

const SITES = {
  tidewell: {
    title: 'Tidewell · Cash flow forecasting',
    favicon: `<svg width="16" height="16" viewBox="0 0 26 26"><rect width="26" height="26" rx="7" fill="#1f4fd8"/><path d="M5 15c2.5-3 5-3 7.5 0s5 3 8.5 0" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M5 10c2.5-3 5-3 7.5 0s5 3 8.5 0" stroke="#a9c1ff" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>`,
  },
  fernway: {
    title: 'The coast road at first light · Fernway',
    favicon: `<svg width="16" height="16" viewBox="0 0 22 26"><path d="M11 25V9M11 15c-4-1-7-4-8-9 4 0 7 2 8 6M11 12c4-1 7-4 8-9-4 0-7 2-8 6" stroke="#8fbf86" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  },
  larder: {
    title: 'Larder · Cook what you already have',
    favicon: `<svg width="16" height="16" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill="#0f2530"/><path d="M10 6v16M7 6v5a3 3 0 0 0 6 0V6M19 6c-2.5 2-2.5 6.5 0 8v8" stroke="#e8f8f4" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>`,
  },
};

// --- geometry ------------------------------------------------------------------------
const W = 1280; // store screenshot size
const H = 800;
const DPR = 2; // captures are taken at 2x and shown at 1x
const MARGIN = 72;
const VIEW = { width: W - 2 * MARGIN, height: 560 }; // the page area of the drawn window
// Pages are shown at 120% zoom so they stay legible when the store scales the
// screenshots down. The popup is not zoomed (page zoom doesn't apply to it).
const ZOOM = 1.2;
const PAGE = { width: Math.round(VIEW.width / ZOOM), height: Math.round(VIEW.height / ZOOM) }; // CSS px of a captured page
const WIN_TOP = 168;
const CHROME_H = 76; // tab strip + toolbar of the drawn window
// Screenshot 2: three narrow windows side by side.
const GAP = 24;
const COL_W = (VIEW.width - 2 * GAP) / 3;
const MINI_CHROME = 30;
const NARROW = { width: 600, height: Math.round(((H - WIN_TOP - MINI_CHROME) * 600) / COL_W) };
// Marquee promo tile (1400x560): the name on the left, a before/after window on the right
// that runs off the bottom edge. Its page is the same layout as screenshot 1, captured
// in a taller viewport so it fills the window.
const MW = 1400;
const MH = 560;
const MWIN = { left: 572, top: 72, width: MW - 572 - 64 };
const MVIEW = { width: MWIN.width, height: MH - MWIN.top - CHROME_H };
const MQ_PAGE = { width: PAGE.width, height: Math.ceil((MVIEW.height * PAGE.width) / MVIEW.width) };

// --- browser -----------------------------------------------------------------------
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-shots-'));
const { context, sw, extensionId } = await launchWithExtension({
  chromePath: process.env.CHROME || findChrome(),
  userDataDir,
  repo,
  extraArgs: ['--host-resolver-rules=MAP *.example 127.0.0.1', '--disable-features=HttpsUpgrades'],
});
const extOrigin = `chrome-extension://${extensionId}`;

const configure = (patch) =>
  sw.evaluate(async (p) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, ...p } });
  }, patch);
const forgetVerdicts = () => sw.evaluate(() => chrome.storage.local.remove('verdicts'));
const tabIdOf = (u) => sw.evaluate(async (x) => (await chrome.tabs.query({})).find((t) => t.url === x)?.id, u);
const png = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const pngSize = (buf, scale = DPR) => ({ w: buf.readUInt32BE(16) / scale, h: buf.readUInt32BE(20) / scale });

// Playwright's viewport sets the layout size. Captures go through CDP with a
// pixel-density override applied just before (Playwright's own screenshot
// resets the density to its own).
async function capture(p, session, size, dpr) {
  await session.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: dpr, mobile: false });
  await p.waitForTimeout(250);
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  await session.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
  const buf = Buffer.from(data, 'base64');
  const got = pngSize(buf, 1);
  if (Math.abs(got.w - size.width * dpr) > 2) throw new Error(`capture is ${got.w}x${got.h}, expected ${size.width * dpr} wide`);
  return buf;
}

const page = await context.newPage();
await page.emulateMedia({ colorScheme: 'dark' });
const cdp = await context.newCDPSession(page);
let size = PAGE;
async function resize(s) {
  size = s;
  await page.setViewportSize(s);
}
// Window captures are taken at DPR * ZOOM, so a page shown at VIEW size has 2 device px per px.
const shoot = () => capture(page, cdp, size, size === PAGE ? DPR * ZOOM : DPR);

async function status() {
  const id = await tabIdOf(page.url());
  return sw.evaluate(async (tab) => {
    try {
      return await chrome.tabs.sendMessage(tab, { type: 'adm:getStatus' }, { frameId: 0 });
    } catch (e) {
      return { state: 'none', reason: String(e) };
    }
  }, id);
}
async function expectState(want, what) {
  const s = await status();
  if (!s || s.state !== want) throw new Error(`${what}: expected ${want}, got ${s && `${s.state}/${s.reason}`}`);
}
// Visit a site with the extension off (original) or on (adapted).
async function visit(site, adapted, ms = 2200) {
  await configure(adapted ? { mode: 'system', scope: 'all', sites: {}, dismissed: {} } : { mode: 'off' });
  await forgetVerdicts();
  await page.goto(url(site));
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(adapted ? ms : 800);
  if (adapted) await expectState('active', `${site} adapted`);
}
// Scroll so the element's top sits `offset` px under the viewport top, and wait for the layout pass.
async function scrollTo(sel, offset = 0) {
  await page.locator(sel).evaluate((el, o) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o), offset);
  await page.waitForTimeout(900);
}
async function box(sel) {
  return page.locator(sel).evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
}

// --- captures ----------------------------------------------------------------------
const shots = {};

// 1. Tidewell, original and adapted, first screen; the split goes through the product preview.
await resize(PAGE);
await visit('tidewell', false);
shots.tidewellBefore = await shoot();
const appBox = await box('.app');
await visit('tidewell', true);
shots.tidewellAfter = await shoot();

// Close-up A: Tidewell's partner logos, original and adapted (they must flip).
const LOGO_ROW = '.logos .row-l';
await scrollTo('.logos', 120);
const logoBox = await box(LOGO_ROW);
shots.logosAfter = await shoot();
const flipped = await page.locator(`${LOGO_ROW} img`).evaluateAll((imgs) => imgs.map((i) => i.getAttribute('data-adm-img')));
if (!flipped.every((v) => v === 'inv')) throw new Error(`logos not all inverted: ${flipped.join(',')}`);
await scrollTo('.rows', 150);
const rowsBox = await box('.rows');
shots.rowsAfter = await shoot();
await visit('tidewell', false);
await scrollTo('.logos', 120);
shots.logosBefore = await shoot();
await scrollTo('.rows', 150);
shots.rowsBefore = await shoot();

// Marquee: Tidewell again, original and adapted, in the taller viewport.
await resize(MQ_PAGE);
await visit('tidewell', false);
shots.mqBefore = await shoot();
const mqApp = await box('.app');
await visit('tidewell', true);
shots.mqAfter = await shoot();
await resize(PAGE);

// Close-up B: Fernway's article text (drop cap, link, pull quote).
await visit('fernway', false);
await scrollTo('.text', 40);
const textBox = await box('.text');
shots.textBefore = await shoot();
await visit('fernway', true);
await scrollTo('.text', 40);
shots.textAfter = await shoot();
await expectState('active', 'fernway text');

// 2. All three, adapted, at a narrow width.
await resize(NARROW);
for (const site of ['fernway', 'larder', 'tidewell']) {
  await visit(site, true);
  shots[`${site}Narrow`] = await shoot();
}

// 4. Larder adapted, and the popup for its tab.
await resize(PAGE);
await visit('larder', true);
shots.larderAfter = await shoot();
const popup = await context.newPage();
await popup.setViewportSize({ width: 344, height: 760 });
await popup.emulateMedia({ colorScheme: 'dark' });
const pcdp = await context.newCDPSession(popup);
await popup.goto(`${extOrigin}/src/popup/popup.html?tab=${await tabIdOf(page.url())}`);
await popup.waitForTimeout(900);
if (!/Adapted to dark/.test(await popup.locator('#status').textContent())) throw new Error('popup does not show the adapted state');
const popupH = await popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
await popup.setViewportSize({ width: 344, height: popupH });
shots.popup = await capture(popup, pcdp, { width: 344, height: popupH }, DPR);
await popup.close();

// 5. Fernway, bright, with the "Try" offer (default settings: ask per site).
await page.bringToFront();
await configure({ mode: 'system', scope: 'ask', sites: {}, dismissed: {} });
await forgetVerdicts();
await page.goto(url('fernway'));
await page.waitForLoadState('networkidle').catch(() => {});
await page.waitForTimeout(2200);
await expectState('offer', 'fernway offer');
shots.offer = await shoot();
// The card's box, from the DOM (it lives in a closed shadow root, which CDP
// can still see with pierce: true).
const offerBox = await (async () => {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const isCard = (n) => n.nodeName === 'DIV' && (n.attributes || []).some((v, i, a) => i % 2 === 0 && v === 'class' && a[i + 1].split(' ').includes('card'));
  const find = (n, inOffer) => {
    if (inOffer && isCard(n)) return n;
    for (const c of [...(n.shadowRoots || []), ...(n.children || [])]) {
      const hit = find(c, inOffer || n.nodeName === 'ADM-OFFER');
      if (hit) return hit;
    }
    return null;
  };
  const node = find(root, false);
  if (!node) throw new Error('offer card not found');
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId });
  const [x1, y1, , , x3, y3] = model.border;
  return { x: x1, y: y1, w: x3 - x1, h: y3 - y1 };
})();

// --- composition -------------------------------------------------------------------
await configure({ mode: 'off' }); // the composition page itself must not be adapted
const comp = await context.newPage();
const icon = png(fs.readFileSync(path.join(repo, 'icons/icon128.png')));
const stroke = (d, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="#c4c7c5" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; overflow: hidden; position: relative; background: #0e0e10; color: #f5f5f7;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .head { position: absolute; left: ${MARGIN}px; right: ${MARGIN}px; top: 50px; }
  .head h1 { margin: 0; font-size: 44px; line-height: 1.08; font-weight: 700; letter-spacing: -0.026em; }
  .head p { margin: 12px 0 0; font-size: 19px; line-height: 1.4; color: #a1a1a6; letter-spacing: -0.006em; }
  .win { position: absolute; border-radius: 12px 12px 0 0; overflow: hidden; background: #2a2b2e;
    box-shadow: 0 0 0 1px rgb(255 255 255 / 0.09), 0 30px 90px rgb(0 0 0 / 0.6); }
  .tabs { height: 38px; display: flex; align-items: flex-end; padding: 0 12px; background: #18181a; }
  .lights { display: flex; gap: 8px; align-self: center; margin-right: 18px; }
  .lights i { display: block; width: 12px; height: 12px; border-radius: 50%; }
  .tab { height: 30px; width: 270px; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 12px;
    border-radius: 9px 9px 0 0; background: #2a2b2e; font-size: 12.5px; color: #e3e3e6; }
  .tab span { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .bar { height: 38px; display: flex; align-items: center; gap: 12px; padding: 0 10px 0 12px; background: #2a2b2e; border-bottom: 1px solid #111; }
  .omni { flex: 1; height: 28px; border-radius: 14px; background: #1c1c1e; display: flex; align-items: center; gap: 8px;
    padding: 0 12px; font-size: 13px; color: #e3e3e6; }
  .ext { width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; }
  .ext.on { background: rgb(255 255 255 / 0.12); }
  .ext img { width: 18px; height: 18px; }
  .page { position: absolute; left: 0; overflow: hidden; }
  .mini { height: ${MINI_CHROME}px; display: flex; align-items: center; gap: 10px; padding: 0 12px; background: #18181a; font-size: 12px; color: #bdbdc2; }
  .mini .lights { margin-right: 4px; gap: 6px; }
  .mini .lights i { width: 9px; height: 9px; }
  .tag { position: absolute; bottom: 16px; padding: 5px 9px; border-radius: 6px; font-size: 12px; font-weight: 600;
    letter-spacing: 0.01em; color: #fff; background: rgb(0 0 0 / 0.72); }
  .label { font-size: 12px; font-weight: 600; color: #8e8e93; letter-spacing: 0.02em; margin: 0 0 6px; }
`;
const lights = `<div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>`;

const WIN_AT = { left: MARGIN, top: WIN_TOP, width: VIEW.width, height: VIEW.height, bottom: H };
function browser(site, inner, { extOn = false, at = WIN_AT } = {}) {
  const s = SITES[site];
  return `<div class="win" style="left:${at.left}px;top:${at.top}px;width:${at.width}px;height:${at.bottom - at.top + 20}px">
    <div class="tabs">${lights}<div class="tab">${s.favicon}<span>${s.title}</span>${stroke('M5 5l6 6M11 5l-6 6', 14)}</div></div>
    <div class="bar">
      ${stroke('M10 3L5 8l5 5')}${stroke('M6 3l5 5-5 5')}${stroke('M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3')}
      <div class="omni">${stroke('M4.5 7V5.5a3.5 3.5 0 0 1 7 0V7M3.5 7h9v6h-9z', 14)}${site}.example</div>
      <div class="ext${extOn ? ' on' : ''}"><img src="${icon}" alt=""></div>
    </div>
    <div class="page" style="top:${CHROME_H}px;width:${at.width}px;height:${at.height}px">${inner}</div>
  </div>`;
}
const full = (buf) => `<img src="${png(buf)}" style="display:block;width:${VIEW.width}px;height:${VIEW.height}px">`;
const head = (title, sub) => `<div class="head"><h1>${title}</h1><p>${sub}</p></div>`;

async function compose(name, body, dims = { width: W, height: H }) {
  await comp.setViewportSize(dims);
  await comp.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
    <body style="width:${dims.width}px;height:${dims.height}px">${body}</body></html>`);
  await comp.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  await comp.waitForTimeout(150);
  const file = path.join(name.startsWith('promo') ? path.join(repo, 'store') : outDir, `${name}.png`);
  await comp.screenshot({ path: file });
  console.log(path.relative(repo, file));
}

// A before/after split with a handle.
const handle = (x, y, r = 20) => `
  <div style="position:absolute;top:0;bottom:0;left:${x - 1}px;width:2px;background:#fff;box-shadow:0 0 0 1px rgb(0 0 0 / 0.18),0 0 14px rgb(0 0 0 / 0.45)"></div>
  <div style="position:absolute;left:${x - r}px;top:${y - r}px;width:${2 * r}px;height:${2 * r}px;border-radius:50%;background:#fff;
    box-shadow:0 4px 14px rgb(0 0 0 / 0.4);display:grid;place-items:center">
    <svg width="${r}" height="${r}" viewBox="0 0 20 20" fill="none" stroke="#1d1d1f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5L2 10l5 5M13 5l5 5-5 5"/></svg>
  </div>`;
const split = (left, right, w, h, at) => `
  <img src="${png(left)}" style="position:absolute;inset:0;width:${w}px;height:${h}px">
  <div style="position:absolute;inset:0;clip-path:inset(0 0 0 ${at}px)"><img src="${png(right)}" style="display:block;width:${w}px;height:${h}px"></div>`;
// A region of a page capture (CSS px of the page), shown at scale `s`.
const crop = (buf, r, s, radius = 10) => `<div style="width:${r.w * s}px;height:${r.h * s}px;border-radius:${radius}px;
  background:url(${png(buf)}) -${r.x * s}px -${r.y * s}px/${PAGE.width * s}px auto no-repeat"></div>`;

// 1. Before and after, split through the product preview.
const splitX = Math.round((appBox.x + appBox.w * 0.42) * ZOOM);
await compose(
  '1-before-after',
  head('Light websites, presented as dark', 'Runs while your system is in dark mode. Surfaces turn dark, text stays readable and colors keep their hue.') +
    browser('tidewell', `${split(shots.tidewellBefore, shots.tidewellAfter, VIEW.width, VIEW.height, splitX)}${handle(splitX, Math.round(appBox.y * ZOOM) - 28)}
      <div class="tag" style="left:16px">Original</div><div class="tag" style="right:16px">Adaptive Dark Mode</div>`, { extOn: true }),
);

// 2. Three kinds of site, adapted.
const col = (i, site, label) => {
  const left = MARGIN + i * (COL_W + GAP);
  const pageH = H - WIN_TOP - MINI_CHROME + 20;
  return `<div class="win" style="left:${left}px;top:${WIN_TOP}px;width:${COL_W}px;height:${H - WIN_TOP + 20}px">
      <div class="mini">${lights}${SITES[site].favicon}<span>${site}.example</span></div>
      <div class="page" style="top:${MINI_CHROME}px;width:${COL_W}px;height:${pageH}px">
        <img src="${png(shots[`${site}Narrow`])}" style="display:block;width:${COL_W}px">
      </div>
      <div class="tag" style="left:12px;bottom:36px">${label}</div>
    </div>`;
};
await compose(
  '2-every-site',
  head('Works on the sites you read', 'Magazines, recipe sites, web apps: each keeps its own colors and photos, now in dark.') +
    col(0, 'fernway', 'Magazine') + col(1, 'larder', 'Recipes') + col(2, 'tidewell', 'Web app'),
);

// 3. Details: logos flip, status colors stay, text stays readable. Original above, adapted below.
const TILE_W = (VIEW.width - 24) / 2;
const AREA_H = H - WIN_TOP - 40;
// A tile with one or more crops: all originals in one group, all adapted ones below.
function tile(left, title, sub, pairs) {
  const cropW = TILE_W - 40;
  const gap = 8;
  const overhead = 22 + 20 + 66 + 2 * 24 + 14 + 2 * gap * (pairs.length - 1);
  let scales = pairs.map((p) => cropW / p.r.w);
  const total = 2 * pairs.reduce((sum, p, i) => sum + p.r.h * scales[i], 0);
  const k = Math.min(1, (AREA_H - overhead) / total);
  scales = scales.map((v) => v * k);
  const group = (which) => pairs.map((p, i) => `<div style="margin:0 auto ${i < pairs.length - 1 ? gap : 0}px;width:${p.r.w * scales[i]}px">${crop(p[which], p.r, scales[i])}</div>`).join('');
  const w = Math.max(...pairs.map((p, i) => p.r.w * scales[i]));
  return `<div style="position:absolute;left:${left}px;top:${WIN_TOP}px;width:${TILE_W}px;height:${AREA_H}px;padding:22px 20px 20px;border-radius:16px;
      background:#18181b;box-shadow:0 0 0 1px rgb(255 255 255 / 0.08)">
    <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">${title}</div>
    <div style="font-size:14px;line-height:1.4;color:#a1a1a6;margin:4px 0 16px">${sub}</div>
    <div style="width:${w}px;margin:0 auto"><div class="label">Original</div>${group('before')}
    <div style="height:14px"></div><div class="label">Adaptive Dark Mode</div>${group('after')}</div>
  </div>`;
}
const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
const logos3 = { ...pad(logoBox, 14), w: Math.min(logoBox.w * 0.62, 560) + 28 };
const textCut = { x: textBox.x - 16, y: textBox.y - 12, w: Math.min(textBox.w, 600) + 32, h: 236 };
await compose(
  '3-details',
  head('Keeps what makes a site recognizable', 'Brand colors, badges and photos stay as they are. Plain black-and-white logos flip so they stay visible.') +
    tile(MARGIN, 'Logos flip, status colors stay', 'Black-and-white logos are inverted. Green, amber and red keep their meaning.', [
      { before: shots.logosBefore, after: shots.logosAfter, r: logos3 },
      { before: shots.rowsBefore, after: shots.rowsAfter, r: pad(rowsBox, 8) },
    ]) +
    tile(MARGIN + TILE_W + 24, 'Readable on every surface', 'Text is checked against what is behind it and brought to 4.5:1 contrast.', [
      { before: shots.textBefore, after: shots.textAfter, r: textCut },
    ]),
);

// 4. The popup, opened from the toolbar, over the adapted recipe site.
const pop = pngSize(shots.popup);
await compose(
  '4-popup',
  head('Every setting, one click away', 'Turn it on for a site or for every bright page, choose how dark, and fix a page that looks off.') +
    browser('larder', full(shots.larderAfter), { extOn: true }) +
    `<img src="${png(shots.popup)}" style="position:absolute;left:${MARGIN + VIEW.width - 10 - pop.w}px;top:${WIN_TOP + CHROME_H + 2}px;
      width:${pop.w}px;height:${pop.h}px;border-radius:10px;box-shadow:0 0 0 1px rgb(255 255 255 / 0.1),0 18px 50px rgb(0 0 0 / 0.55)">`,
);

// 5. The offer card, picked out on the bright magazine page.
const ring = 6;
await compose(
  '5-try-offer',
  head('Try it on any bright page', 'A small card offers a preview. Try adapts the page and remembers the site.') +
    browser('fernway', `${full(shots.offer)}
      <div style="position:absolute;left:${offerBox.x * ZOOM - ring}px;top:${offerBox.y * ZOOM - ring}px;width:${offerBox.w * ZOOM + 2 * ring}px;height:${offerBox.h * ZOOM + 2 * ring}px;
        border-radius:${14 * ZOOM + ring}px;box-shadow:0 0 0 2px #409cff,0 0 24px 4px rgb(64 156 255 / 0.35)"></div>`),
);

// Small promo tile (440x280): the product page split, above the name.
const PW = 400;
const PH = 170;
// The product preview card, split through its middle.
const card = { x: appBox.x * ZOOM, y: appBox.y * ZOOM, w: appBox.w * ZOOM };
const promoSplit = Math.round(card.x + card.w / 2);
const region = { x: card.x - 24, y: card.y - 18, w: card.w + 48 };
const ps = PW / region.w;
await compose(
  'promo-440x280',
  `<div style="position:absolute;left:20px;top:20px;width:${PW}px;height:${PH}px;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px rgb(255 255 255 / 0.1)">
     <div style="position:absolute;left:${-region.x * ps}px;top:${-region.y * ps}px;width:${VIEW.width}px;height:${VIEW.height}px;transform:scale(${ps});transform-origin:0 0">${split(shots.tidewellBefore, shots.tidewellAfter, VIEW.width, VIEW.height, promoSplit)}</div>
     ${handle((promoSplit - region.x) * ps, PH / 2, 14)}
   </div>
   <div style="position:absolute;left:0;right:0;top:${20 + PH}px;bottom:0;display:flex;align-items:center;justify-content:center;gap:12px">
     <img src="${icon}" style="width:44px;height:44px">
     <div style="font-size:26px;font-weight:700;letter-spacing:-0.02em">Adaptive Dark Mode</div>
   </div>`,
  { width: 440, height: 280 },
);

// Marquee promo tile (1400x560).
const ms = MVIEW.width / PAGE.width;
const mSplit = Math.round((mqApp.x + mqApp.w * 0.42) * ms);
await compose(
  'promo-marquee-1400x560',
  `<div style="position:absolute;left:80px;top:0;bottom:0;width:${MWIN.left - 80 - 56}px;display:flex;flex-direction:column;justify-content:center">
     <img src="${icon}" style="width:64px;height:64px;margin-bottom:24px">
     <div style="font-size:60px;line-height:1.02;font-weight:700;letter-spacing:-0.03em">Adaptive<br>Dark Mode</div>
     <div style="font-size:21px;line-height:1.42;color:#c7c7cc;margin-top:18px;letter-spacing:-0.006em">Light websites, presented as dark. Colors, logos and photos stay right.</div>
     <div style="font-size:15px;color:#8e8e93;margin-top:20px">Free and open source · No account, no tracking</div>
   </div>` +
    browser(
      'tidewell',
      `${split(shots.mqBefore, shots.mqAfter, MVIEW.width, MVIEW.height, mSplit)}${handle(mSplit, Math.round(mqApp.y * ms) - 20, 18)}`,
      { extOn: true, at: { ...MWIN, height: MVIEW.height, bottom: MH } },
    ),
  { width: MW, height: MH },
);

await context.close();
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
