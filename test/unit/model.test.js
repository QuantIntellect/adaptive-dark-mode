// Unit tests for the pure parts: color math, the transform model (including
// the calibration points measured from WebKit's ADM screenshots), value
// rewriting, policy, image classification and the source-text indexer.
const test = require('node:test');
const assert = require('node:assert/strict');

require('../../src/shared/color.js');
require('../../src/shared/transform.js');
require('../../src/shared/settings.js');
require('../../src/shared/imageclass.js');
require('../../src/content/sheets.js');

const { color: C, transform: T, settings: S, imageclass: IC, SheetEngine } = globalThis.ADM;
const model = T.createModel({ depth: 'standard', textContrast: 4.5 });
const Y = (css) => C.luminance(C.parse(css));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}±${eps}, got ${a}`);

test('parses every CSS color syntax Chrome serializes', () => {
  const cases = {
    '#fff': '#ffffff',
    '#ffff': '#ffffff',
    '#1e1e1e': '#1e1e1e',
    '#1e1e1e80': 'rgb(30 30 30 / 0.502)',
    'rgb(255, 0, 0)': '#ff0000',
    'rgba(0, 0, 0, 0.5)': 'rgb(0 0 0 / 0.5)',
    'rgb(0 128 0 / 50%)': 'rgb(0 128 0 / 0.5)',
    'hsl(120 100% 25%)': '#008000',
    'hwb(0 0% 0%)': '#ff0000',
    'oklch(1 0 0)': '#ffffff',
    'lab(0 0 0)': '#000000',
    'color(srgb 1 1 1)': '#ffffff',
    'color(display-p3 0 0 0)': '#000000',
    RebeccaPurple: '#663399',
    transparent: 'rgb(0 0 0 / 0)',
  };
  for (const [input, out] of Object.entries(cases)) assert.equal(C.format(C.parse(input)), out, input);
  for (const bad of ['var(--x)', 'currentcolor', 'canvas', 'linear-gradient(red, blue)', 'rgb(from red r g b)']) {
    assert.equal(C.parse(bad), null, bad);
  }
});

test('WCAG contrast basics', () => {
  near(C.contrast(C.parse('#000'), C.parse('#fff')), 21, 1e-6);
  near(C.contrast(C.parse('#777'), C.parse('#fff')), 4.48, 0.01);
});

test('withLuminance keeps hue and hits the target luminance', () => {
  const c = C.parse('#2563eb');
  for (const target of [0.05, 0.2, 0.5]) {
    const out = C.withLuminance(c, target);
    near(C.luminance(out), target, 0.004, 'luminance');
    near(C.toOklch(out).H, C.toOklch(c).H, 3, 'hue');
  }
});

test('the flip is a contrast-preserving involution anchored at #1e1e1e', () => {
  assert.equal(model.anchorCss, '#1e1e1e');
  assert.equal(model.transformColorString('#ffffff', 'bg'), '#1e1e1e');
  // card on page keeps its WCAG ratio after the flip (Safari: 1.163 -> 1.17)
  const card = C.parse('#f4fbf8');
  const page = C.parse('#d8ede8');
  const before = C.contrast(card, page);
  const after = C.contrast(model.flip(card), model.flip(page));
  near(after, before, 0.02, 'ratio');
  // involution in luminance (below the output cap)
  for (const y of [0.1, 0.3, 0.6]) near(model.flipY(model.flipY(y)), y, 1e-9);
});

test('calibration: matches values measured from WebKit ADM screenshots', () => {
  // Safari: paragraph gray #4a4a4a -> #bebebe
  const para = C.parse(model.transformColorString('#4a4a4a', 'fg'));
  near(C.luminance(para), Y('#bebebe'), 0.03, '#4a4a4a');
  // Safari: link blue #4470e2 -> luminance 0.229 (lightened just to ~4.5:1)
  near(Y(model.transformColorString('#4470e2', 'fg')), 0.229, 0.02, 'link');
  // Safari: teal badge #48a096 and blue badge #354af5 unchanged
  assert.equal(model.transformColorString('#48a096', 'bg'), '#48a096');
  assert.equal(model.transformColorString('#354af5', 'bg'), '#354af5');
  // Safari: large dark card #1a3a48 unchanged
  assert.equal(model.transformColorString('#1a3a48', 'bg'), '#1a3a48');
  // Safari: lime chip #ceee56 dimmed to ~Y 0.6, hue kept
  near(Y(model.transformColorString('#ceee56', 'bg')), 0.6, 0.05, 'lime');
});

test('role rules', () => {
  // light text stays (judged later against its real backdrop)
  assert.equal(model.transformColorString('#ffffff', 'fg'), '#ffffff');
  // dark text becomes light
  assert.ok(Y(model.transformColorString('#111111', 'fg')) > 0.7);
  // dark drop shadows stay shadows, white glows go dark
  assert.equal(model.transformColorString('rgba(0,0,0,.2)', 'sh'), 'rgba(0,0,0,.2)');
  assert.ok(Y(model.transformColorString('#ffffff', 'sh')) < 0.05);
  // low-alpha dark hover tints become light tints; modal scrims stay dark
  assert.ok(Y(model.transformColorString('rgba(0,0,0,.05)', 'bg')) > 0.5);
  assert.equal(model.transformColorString('rgba(0,0,0,.5)', 'bg'), 'rgba(0,0,0,.5)');
  // dark borders become visible but never glaring
  const bd = Y(model.transformColorString('#000000', 'bd'));
  assert.ok(bd > 0.2 && bd <= 0.36, String(bd));
});

test('ensureContrast reaches the target on the darker side when lighter is impossible', () => {
  const lime = C.parse('#b8d73a');
  const out = model.ensureContrast(C.parse('#e8e8e8'), lime, 4.5);
  assert.ok(C.contrast(out, lime) >= 4.49);
  assert.ok(C.luminance(out) < C.luminance(lime));
});

test('value rewriting', () => {
  const ctx = { base: 'https://cdn.example/css/site.css' };
  assert.equal(
    model.transformValue('linear-gradient(#fff 0%, #f0f0f0 100%), url(img/a.png)', 'bg', ctx),
    'linear-gradient(#1e1e1e 0%, #292929 100%), url("https://cdn.example/css/img/a.png")',
  );
  // ring shadow treated like a border, drop shadow kept
  assert.equal(model.transformValue('0 1px 2px rgba(0,0,0,.2), 0 0 0 1px #e5e5e5', 'sh'), '0 1px 2px rgba(0,0,0,.2), 0 0 0 1px #303030');
  // var() gets a role-specific variant with the original as fallback
  assert.equal(model.transformValue('1px solid var(--line, #ddd)', 'bd'), '1px solid var(--adm-bd-line, var(--line, #353535))');
  // Tailwind alpha variable is left alone, the channels are transformed
  assert.equal(model.transformValue('rgb(255 255 255 / var(--tw-bg-opacity, 1))', 'bg'), 'rgb(30 30 30 / var(--tw-bg-opacity, 1))');
  // shadcn channels
  assert.equal(model.transformValue('hsl(var(--background) / 0.8)', 'bg'), 'hsl(var(--adm-bg-background, var(--background)) / 0.8)');
  // things that must not change
  for (const v of ['"white"', 'redbox', 'Canvas', 'currentColor', 'light-dark(#fff, #000)', 'url(white.png)']) {
    assert.equal(model.transformValue(v, 'bg'), v, v);
  }
});

test('custom property variants', () => {
  assert.deepEqual(model.defineVariants('--background', '0 0% 100%')[0], ['--adm-bg-background', '0 0% 11.8%']);
  assert.deepEqual(model.defineVariants('--bs-body-bg-rgb', '255, 255, 255')[0], ['--adm-bg-bs-body-bg-rgb', '30, 30, 30']);
  assert.equal(model.defineVariants('--space', '4px'), null);
  assert.equal(model.defineVariants('--font', 'Inter, sans-serif'), null);
  const chained = model.defineVariants('--btn-bg', 'var(--primary)');
  assert.equal(chained[0][1], 'var(--adm-bg-primary, var(--primary))');
});

test('exclusion selectors keep specificity and pseudo-elements valid', () => {
  assert.equal(T.addExclusion('p::before'), 'p:not(:where([data-adm-x],[data-adm-x] *))::before');
  assert.equal(T.addExclusion('a:hover:after'), 'a:hover:not(:where([data-adm-x],[data-adm-x] *)):after');
  assert.equal(T.addExclusion(':root, .a'), ':root,.a:not(:where([data-adm-x],[data-adm-x] *))');
});

test('policy mirrors Safari gates', () => {
  const s = S.withDefaults(null);
  assert.equal(S.policy(s, 'example.com', false).reason, 'system-light');
  assert.equal(S.policy({ ...s, mode: 'always' }, 'example.com', false).reason, 'ask');
  assert.equal(S.policy(s, 'example.com', true).offer, true);
  assert.equal(S.policy({ ...s, scope: 'all' }, 'example.com', true).wanted, true);
  assert.equal(S.policy({ ...s, sites: { 'example.com': 'off' } }, 'www.example.com', true).reason, 'site-off');
  assert.equal(S.policy(s, 'docs.google.com', true).reason, 'quirk-disabled');
  assert.equal(S.policy({ ...s, sites: { 'docs.google.com': 'on' } }, 'docs.google.com', true).wanted, true);
  assert.equal(S.policy({ ...s, dismissed: { 'example.com': Date.now() } }, 'example.com', true).offer, false);
});

function pixels(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      data.set([r, g, b, a], (y * w + x) * 4);
    }
  }
  return data;
}

test('image classification', () => {
  // black text on a baked-in white field -> invert
  const logo = pixels(64, 20, (x, y) => (x > 8 && x < 56 && y > 6 && y < 14 && x % 6 < 3 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  assert.equal(IC.classifyPixels(logo, 64, 20).kind, 'invert');
  // dark glyph with a blue accent on transparent -> invert (hue is preserved)
  const mark = pixels(32, 32, (x, y) => (x < 4 && y < 4 ? [14, 101, 192, 255] : x > 8 && x < 24 && y > 8 && y < 24 ? [10, 10, 10, 255] : [0, 0, 0, 0]));
  assert.equal(IC.classifyPixels(mark, 32, 32).kind, 'invert');
  // a colorful photo -> keep
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) % 256);
  const photo = pixels(32, 32, () => [rnd(), rnd(), rnd(), 255]);
  assert.equal(IC.classifyPixels(photo, 32, 32).kind, 'keep');
  // flat light paper -> texture
  const paper = pixels(16, 16, (x, y) => [246 - ((x + y) % 3), 244, 238, 255]);
  assert.equal(IC.classifyPixels(paper, 16, 16).kind, 'texture');
  // SVG paints
  assert.equal(IC.classifyPaints([C.parse('#111')]).kind, 'invert');
  assert.equal(IC.classifyPaints([C.parse('#111'), C.parse('#fff')]).kind, 'keep');
});

test('source indexer recovers var() shorthands CSSOM loses', () => {
  const css = `/* c */ .a::after{content:"";background:linear-gradient(rgba(255,255,255,0),var(--bg,#fff));background-repeat:no-repeat}
    @media (min-width:1px){ .b > .c , .d:before { border: 1px solid var(--line) !important } }`;
  const index = SheetEngine.indexSource(css);
  assert.ok(index.get('.a::after')[0].includes('var(--bg,#fff)'));
  assert.ok(index.get(SheetEngine.normSelector('.b > .c, .d::before'))[0].includes('var(--line)'));
});
