// End-to-end check: load the unpacked extension into Chrome for Testing with a
// dark color scheme, render the fixtures (and optionally real sites), save
// before/after screenshots and assert the rules from the design.
//
//   node test/e2e/run.mjs            fixtures only
//   node test/e2e/run.mjs --sites    fixtures + a handful of real websites
//   CHROME=/path/to/chrome node test/e2e/run.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, findChrome } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const fixtures = path.join(repo, 'test/fixtures');
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

const withSites = process.argv.includes('--sites');
const chromePath = process.env.CHROME || findChrome();

// --- static servers (second port = cross-origin) ----------------------------
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.js': 'text/javascript' };
function serve(port) {
  const server = http.createServer((req, res) => {
    const file = path.join(fixtures, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(fixtures) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const send = () => {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    };
    // The cross-origin sheet arrives late on purpose: its overrides land after
    // the first layout pass, which must then re-check what is on screen.
    if (port === 4811 && file.endsWith('xo.css')) setTimeout(send, 700);
    else send();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// --- in-page helpers (run in the page's main world) --------------------------
function pageProbe() {
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const Y = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const CR = (a, b) => (Math.max(Y(a), Y(b)) + 0.05) / (Math.min(Y(a), Y(b)) + 0.05);
  const over = (t, b) => {
    const a = t.a + b.a * (1 - t.a);
    if (!a) return { r: 0, g: 0, b: 0, a: 0 };
    const m = (x, y) => (x * t.a + y * b.a * (1 - t.a)) / a;
    return { r: m(t.r, b.r), g: m(t.g, b.g), b: m(t.b, b.b), a };
  };
  const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'EMBED', 'OBJECT']);
  function backdrop(el) {
    const r = [...el.getClientRects()].find((q) => q.width > 2 && q.height > 2 && q.bottom > 0 && q.top < innerHeight);
    if (!r) return null;
    const x = Math.min(Math.max((r.left + r.right) / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max((r.top + r.bottom) / 2, 1), innerHeight - 1);
    const stack = (el.getRootNode().elementsFromPoint ? el.getRootNode() : document).elementsFromPoint(x, y);
    let i = stack.indexOf(el);
    if (i < 0) i = 0;
    let acc = { r: 0, g: 0, b: 0, a: 0 };
    for (const n of stack.slice(i)) {
      if (n !== el && MEDIA.has(n.tagName)) return { media: true };
      if (n instanceof SVGElement) continue;
      const cs = getComputedStyle(n);
      if (cs.backgroundImage.includes('url(')) return { media: true };
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a) acc = over(acc, bg);
      if (acc.a > 0.99) return { color: acc };
    }
    // An unpainted canvas follows the root's used color-scheme.
    let canvas = /dark/.test(getComputedStyle(document.documentElement).colorScheme) ? { r: 0.07, g: 0.07, b: 0.07, a: 1 } : { r: 1, g: 1, b: 1, a: 1 };
    for (const root of [document.documentElement, document.body]) {
      const c = root && parse(getComputedStyle(root).backgroundColor);
      if (c && c.a) {
        canvas = over(c, canvas);
        break;
      }
    }
    return { color: over(acc, canvas) };
  }
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
  return {
    lum: (sel, prop = 'backgroundColor') => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return null;
      const c = parse(getComputedStyle(el)[prop]);
      return c ? Math.round(Y(c) * 1000) / 1000 : null;
    },
    css: (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    },
    attr: (sel, name) => {
      const el = document.querySelector(sel);
      return el ? el.getAttribute(name) : undefined;
    },
    contrastOf: (sel) => {
      const el = document.querySelector(sel);
      const b = el && backdrop(el);
      if (!b || b.media) return null;
      const fg = parse(getComputedStyle(el).color);
      return Math.round(CR(fg.a < 1 ? over(fg, b.color) : fg, b.color) * 100) / 100;
    },
    contrastScan: () => {
      const fails = [];
      let checked = 0;
      const all = [];
      const collect = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) collect(el.shadowRoot);
          all.push(el);
        }
      };
      collect(document);
      for (const el of all) {
        if (!ownText(el) || el.closest('[data-adm-x],script,style,noscript')) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.color === 'rgba(0, 0, 0, 0)') continue;
        if (/text/.test(cs.backgroundClip + cs.webkitBackgroundClip)) continue;
        const b = backdrop(el);
        if (!b || b.media) continue;
        const fg = parse(cs.color);
        if (!fg) continue;
        const ratio = CR(fg.a < 1 ? over(fg, b.color) : fg, b.color);
        const size = parseFloat(cs.fontSize);
        const target = size >= 24 || (parseInt(cs.fontWeight, 10) >= 700 && size >= 18.66) ? 3 : 4.5;
        checked++;
        if (ratio < target - 0.05) fails.push({ text: el.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, target, color: cs.color });
      }
      return { checked, fails };
    },
  };
}

async function inPage(page, fn, ...args) {
  return page.evaluate(
    ([src, fnSrc, a]) => {
      const probe = new Function(`return (${src})()`)();
      return new Function('probe', 'args', `return (${fnSrc})(probe, ...args)`)(probe, a);
    },
    [pageProbe.toString(), fn.toString(), args],
  );
}

async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
  // Scroll through so lazily processed (IntersectionObserver) content is reached.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 700) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.waitForTimeout(120);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

// --- main ----------------------------------------------------------------------
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const s1 = await serve(4810);
const s2 = await serve(4811);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-e2e-'));

const { context, sw, extensionId, browser } = await launchWithExtension({ chromePath, userDataDir, repo, headed: !!process.env.HEADED });
console.log(`Chrome: ${browser.version()}  extension: ${extensionId}`);

async function configure(patch) {
  await sw.evaluate(async (p) => {
    const { settings } = await chrome.storage.local.get('settings');
    const next = { ...settings, ...p };
    await chrome.storage.local.set({ settings: next });
  }, patch);
}
async function status(page) {
  return sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === url);
    if (!t) return null;
    try {
      return await chrome.tabs.sendMessage(t.id, { type: 'adm:getStatus' }, { frameId: 0 });
    } catch (e) {
      return { error: String(e) };
    }
  }, page.url());
}

async function shoot(page, name, fullPage = true) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return file;
}

const base = 'http://127.0.0.1:4810';
const page = await context.newPage();
await page.setViewportSize({ width: 1280, height: 900 });
await page.emulateMedia({ colorScheme: 'dark' });

// Original renders (extension off) for side-by-side review.
await configure({ mode: 'off' });
for (const f of ['light', 'declares-dark', 'light-only', 'dark', 'spa']) {
  await page.goto(`${base}/${f}.html`);
  await settle(page, f === 'spa' ? 1600 : 600);
  await shoot(page, `${f}-off`);
}

// Adapt every bright page automatically.
await configure({ mode: 'system', scope: 'all', depth: 'standard', textContrast: 4.5 });

console.log('\nlight.html');
await sw.evaluate(() => chrome.storage.local.remove('verdicts'));
await page.goto(`${base}/light.html`);
// Before any scrolling (which would re-queue elements and mask the bug):
await page.waitForTimeout(2500);
{
  const cr = await inPage(page, (p) => p.contrastOf('#stale-ink'));
  check('text fix re-checked after a late cross-origin sheet', cr >= 4.5, cr);
}
await settle(page, 600);
await shoot(page, 'light-on');
await shoot(page, 'light-on-viewport', false);
const st = await status(page);
check('state is active', st && st.state === 'active', st && `${st.state}/${st.reason}`);
const L = (sel, prop) => inPage(page, (p, s, pr) => p.lum(s, pr), sel, prop);
const A = (sel, name) => inPage(page, (p, s, n) => p.attr(s, n), sel, name);
const CSSV = (sel, prop) => inPage(page, (p, s, pr) => p.css(s, pr), sel, prop);

check('page background is dark', (await L('body')) < 0.06, await L('body'));
check('hero title over photo keeps white', (await L('#hero-title', 'color')) > 0.9, await L('#hero-title', 'color'));
check('vivid primary button kept', (await CSSV('#primary-btn', 'backgroundColor')) === 'rgb(37, 99, 235)', await CSSV('#primary-btn', 'backgroundColor'));
check('dark footer kept dark', (await CSSV('#footer', 'backgroundColor')) === 'rgb(31, 41, 55)', await CSSV('#footer', 'backgroundColor'));
check('dark card kept dark', (await CSSV('#dark-card', 'backgroundColor')) === 'rgb(26, 58, 72)');
check('light text on dark card kept light', (await L('#dark-sub', 'color')) > 0.35, await L('#dark-sub', 'color'));
check('teal badge kept', (await CSSV('#badge-teal', 'backgroundColor')) === 'rgb(72, 160, 150)');
check('green label text lightened', (await L('#green-text', 'color')) > 0.2, await L('#green-text', 'color'));
check('link lightened to ~4.5:1', (await L('#link', 'color')) > 0.2, await L('#link', 'color'));
check('small dark nav pill flipped light', (await L('#plan-pill')) > 0.4, await L('#plan-pill'));
check('cascade: later unchanged rule still wins (ghost button transparent)', (await CSSV('#ghost-btn', 'backgroundColor')) === 'rgba(0, 0, 0, 0)', await CSSV('#ghost-btn', 'backgroundColor'));
check('variables: later vivid definition wins (red chip stays red)', (await CSSV('#red-chip', 'backgroundColor')) === 'rgb(255, 0, 0)', await CSSV('#red-chip', 'backgroundColor'));
check('variables: default chip flipped dark', (await L('#white-chip')) < 0.05, await L('#white-chip'));
check('decorative full-bleed canvas gets no island', (await A('#deco-canvas', 'data-adm-canvas')) === null);
check('transparent iframe keeps a matching (normal) scheme', await page.evaluate(() => {
  const f = document.getElementById('overlay-frame');
  return getComputedStyle(f).colorScheme === 'normal' && getComputedStyle(f.contentDocument.documentElement).colorScheme === 'normal';
}));
check('dark pill inside the dark footer stays dark', (await L('#footer-pill')) < 0.05, await L('#footer-pill'));
check('dark pill inside the dark card stays dark', (await L('#card-pill')) < 0.05, await L('#card-pill'));
for (const id of ['var-sh', 'xo-sh', 'route-card', 'tw-card', 'shad-card', 'bs-card', 'xo-card', 'layered', 'media-rule', 'supports-rule', 'inline-card', 'inline-var', 'cssinjs-card', 'gradient']) {
  const isGradient = id === 'gradient' || id === 'var-sh';
  const y = isGradient ? await inPage(page, (_p, i) => getComputedStyle(document.getElementById(i)).backgroundImage, id) : await L('#' + id);
  check(`#${id} surface darkened`, isGradient ? /gradient/.test(y) && !y.includes('255, 255, 255') : y < 0.08, y);
}
check('shadow-DOM widget darkened', (await inPage(page, () => {
  const w = document.querySelector('x-widget').shadowRoot.querySelector('.w');
  const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(w).backgroundColor);
  return m ? Number(m[1].split(',')[0]) : 255;
})) < 60);
check('author-managed subtree untouched', (await CSSV('#author-managed', 'backgroundColor')) === 'rgb(17, 34, 51)', await CSSV('#author-managed', 'backgroundColor'));
check('lime chip kept vivid', (await L('#lime-chip')) > 0.4, await L('#lime-chip'));
check('text on lime chip stays dark', (await L('#lime-chip', 'color')) < 0.15, await L('#lime-chip', 'color'));
check('B/W logo inverted', (await A('#img-logo', 'data-adm-img')) === 'inv');
check('dark transparent icon inverted', (await A('#img-icon', 'data-adm-img')) === 'inv');
check('mono SVG <img> inverted', (await A('#img-svg-mono', 'data-adm-img')) === 'inv');
check('colorful SVG <img> kept', (await A('#img-svg-color', 'data-adm-img')) !== 'inv');
check('product photo kept', (await A('#img-product', 'data-adm-img')) !== 'inv');
check('multiply blend turned off', (await CSSV('#img-multiply', 'mixBlendMode')) === 'normal');
check('background-image icon inverted', (await A('#bg-icon', 'data-adm-img')) === 'inv');
check('tiled light texture removed', (await A('#texture', 'data-adm-img')) === 'untex', { attr: await A('#texture', 'data-adm-img'), bg: await CSSV('#texture', 'backgroundImage'), h2: await L('#texture h2', 'color') });
check('SVG app-icon logo inverted as a whole', await inPage(page, (p) => {
  const rect = document.querySelector('#logo-svg rect');
  const path = document.querySelector('#logo-svg path');
  const fill = p.lum(rect, 'fill');
  const stroke = p.lum(path, 'stroke');
  return fill > 0.5 && stroke < 0.2;
}));
check('inline SVG label flipped light', (await L('#svg-label', 'fill')) > 0.4, await L('#svg-label', 'fill'));
check('canvas kept on a light island', (await A('#chart', 'data-adm-canvas')) !== null && (await A('#chart', 'data-adm-canvas')) !== undefined);
check('<td bgcolor> darkened', (await L('#bgcolor-cell')) < 0.1, { y: await L('#bgcolor-cell'), i: await A('#bgcolor-cell', 'data-adm-i'), style: await A('#bgcolor-cell', 'style'), sheets: await page.evaluate(() => document.adoptedStyleSheets.length), st: (await status(page)).state });
check('<font color> lightened', (await L('#font-color', 'color')) > 0.3, await L('#font-color', 'color'));
check('gradient text stays readable', await inPage(page, () => !/rgb\(17, 24, 39\)/.test(getComputedStyle(document.getElementById('gradient-text')).backgroundImage)));
check('root color-scheme is dark', (await CSSV('html', 'colorScheme')) === 'dark');
check('input is dark', (await L('#input')) < 0.1, await L('#input'));
const scan = await inPage(page, (p) => p.contrastScan());
check(`text contrast ≥ target (${scan.checked} elements)`, scan.fails.length === 0, scan.fails.slice(0, 6));
if (st) console.log('  stats', JSON.stringify(st.stats), 'timing', JSON.stringify(st.timing));

// Hover menu: :hover rules are mirrored, so the dropdown is dark too.
await page.hover('.menu');
await page.waitForTimeout(200);
check('hover dropdown is dark', (await L('.dropdown')) < 0.08, await L('.dropdown'));
await shoot(page, 'light-on-hover', false);

console.log('\nre-evaluation stability');
await page.evaluate(() => document.getElementById('dark-band').scrollIntoView());
await page.waitForTimeout(300);
await page.evaluate(() => document.documentElement.classList.add('scrolled-state'));
await page.waitForTimeout(1200);
{
  const s1 = await status(page);
  check('class toggle while scrolled into a dark band keeps it active', s1 && s1.state === 'active', s1 && `${s1.state}/${s1.reason} trigger=${s1.timing && s1.timing.trigger}`);
}
await page.evaluate(() => document.documentElement.classList.add('site-dark'));
await page.waitForTimeout(1200);
{
  const s2 = await status(page);
  check("site switching to its own dark theme turns it off", s2 && s2.state === 'inactive' && s2.reason === 'already-dark', s2 && `${s2.state}/${s2.reason}`);
}
await page.evaluate(() => document.documentElement.classList.remove('site-dark', 'scrolled-state'));
await page.waitForTimeout(1200);
{
  const s3 = await status(page);
  check('and switching back to light turns it on again', s3 && s3.state === 'active', s3 && `${s3.state}/${s3.reason}`);
}
await page.evaluate(() => window.scrollTo(0, 0));

console.log('\nturning it off');
await page.mouse.move(640, 890); // close the hover menu from the previous check
await configure({ sites: { '127.0.0.1': 'off' } });
await page.waitForTimeout(800);
await settle(page, 300);
await shoot(page, 'light-turned-off');
const leftovers = await page.evaluate(() => {
  const attrs = document.querySelectorAll('[data-adm-i],[data-adm-fg],[data-adm-bg],[data-adm-hl],[data-adm-img],[data-adm-svgf],[data-adm-svgs],[data-adm-canvas],[data-adm-base],[data-adm-ctl]').length;
  const props = [...document.querySelectorAll('[style]')].filter((e) => /--adm-/.test(e.getAttribute('style'))).length;
  return { attrs, props, sheets: document.adoptedStyleSheets.length };
});
const offSame = fs.readFileSync(path.join(outDir, 'light-turned-off.png')).equals(fs.readFileSync(path.join(outDir, 'light-off.png')));
check('site off: nothing left behind', leftovers.attrs === 0 && leftovers.props === 0 && leftovers.sheets === 0, leftovers);
check('site off: page pixel-identical to the original', offSame);
await configure({ sites: {} });

console.log('\nopt-out and dark pages');
for (const f of ['declares-dark', 'light-only', 'dark']) {
  await page.goto(`${base}/${f}.html`);
  await settle(page, 1200);
  await shoot(page, `${f}-on`);
  const untouched = await page.evaluate(() => document.adoptedStyleSheets.length === 0 && !document.querySelector('[data-adm-i],[data-adm-fg],[data-adm-img]'));
  const s = await status(page);
  const same = fs.readFileSync(path.join(outDir, `${f}-on.png`)).equals(fs.readFileSync(path.join(outDir, `${f}-off.png`)));
  check(`${f}: untouched`, untouched && same, s && `${s.state}/${s.reason}${same ? '' : ' (pixels differ)'}`);
}

console.log('\nspa.html');
await page.goto(`${base}/spa.html`);
await settle(page, 2600);
await shoot(page, 'spa-on');
check('late-rendered SPA adapted', (await L('#panel')) < 0.08, await L('#panel'));

console.log('\n"Try" offer (default settings)');
await configure({ scope: 'ask', sites: {}, dismissed: {} });
await sw.evaluate(() => chrome.storage.local.remove('verdicts'));
await page.goto(`${base}/light.html`);
await page.waitForTimeout(1500);
const offerState = await status(page);
const hasOffer = await page.evaluate(() => !!document.querySelector('adm-offer'));
check('bright page shows the Try offer and is not adapted yet', hasOffer && offerState && offerState.state === 'offer', offerState && `${offerState.state}/${offerState.reason}`);
await page.waitForTimeout(400);
await shoot(page, 'offer', false);
// The card is in a closed shadow root: click the "Try" button by position.
await page.mouse.click(1280 - 49, 900 - 44);
await page.waitForTimeout(1200);
const tried = await status(page);
const savedSites = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.sites);
check('clicking Try adapts the page and remembers the site', tried && tried.state === 'active' && savedSites['127.0.0.1'] === 'on', { state: tried && tried.state, sites: savedSites });
await shoot(page, 'offer-applied', false);
await configure({ scope: 'all', sites: {} });

if (withSites) {
  console.log('\nreal sites');
  const sites = [
    'https://example.com/',
    'https://news.ycombinator.com/',
    'https://en.wikipedia.org/wiki/Dark_mode',
    'https://www.gnu.org/',
    'https://lite.cnn.com/',
    'https://developer.mozilla.org/en-US/',
    'https://github.com/',
    'https://www.craigslist.org/about/sites',
    'https://stripe.com/',
    'https://www.bbc.com/news',
    'https://www.apple.com/iphone/',
    'https://stackoverflow.com/questions',
  ];
  // Long tasks (>50 ms) on the main thread, page + extension, off vs on.
  await page.addInitScript(() => {
    window.__lt = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__lt += e.duration;
      }).observe({ type: 'longtask', buffered: true });
    } catch (_) {
      /* unsupported */
    }
  });
  for (const url of sites) {
    const name = 'site-' + new URL(url).hostname.replace(/^www\./, '').replace(/\./g, '_');
    try {
      await configure({ mode: 'off' });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page, 1500);
      await shoot(page, `${name}-off`, false);
      const ltOff = Math.round(await page.evaluate(() => window.__lt || 0));
      await configure({ mode: 'system' });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page, 2500);
      await shoot(page, `${name}-on`, false);
      const s = await status(page);
      const sc = await inPage(page, (p) => p.contrastScan());
      const t = (s && s.timing) || {};
      const ltOn = Math.round(await page.evaluate(() => window.__lt || 0));
      console.log(`  • ${url}  ${s ? `${s.state}/${s.reason}` : 'no status'}  contrast fails ${sc.fails.length}/${sc.checked}  sheets ${t.sheetTotalMs ?? '-'}ms/${t.sheetSyncs ?? '-'} syncs  long tasks off ${ltOff}ms → on ${ltOn}ms`);
      results.push({ name: url, ok: true, detail: { state: s && s.state, reason: s && s.reason, fails: sc.fails.slice(0, 5), checked: sc.checked, stats: s && s.stats, timing: s && s.timing } });
    } catch (e) {
      console.log(`  • ${url}  error ${e.message.split('\n')[0]}`);
    }
  }
}

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${outDir}`);
await browser.close().catch(() => {});
s1.close();
s2.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
