// Unit tests for the own-dark-theme selector grammar (src/content/detect.js).
// The selectors are taken from real sites (2026-11-20): the ones that ship a
// dark theme behind a setting of their own, and the ones whose "dark" classes
// style a section or a component, not the site.
const test = require('node:test');
const assert = require('node:assert/strict');

require('../../src/shared/color.js');
require('../../src/content/detect.js');

const { detect: D } = globalThis.ADM;

// A root with no attributes or classes, where every class is unused.
const bare = { hasAttr: () => false, family: new Set(), dormant: () => true };
const page = (over) => ({ ...bare, ...over });

test('dark theme rules for the root itself', () => {
  for (const sel of [
    'html[dark]', // YouTube
    'html:not(.style-scope)[dark]', // YouTube
    'body:not(.theme-highcontrast).theme-dark', // Stack Overflow
    'html.skin-theme-clientpref-night', // Wikipedia
    ':root.dark', // Cloudflare
    'html.dark',
    'html.site-dark body',
    '.dark body',
    'html.darkMode',
    'html[dark-theme]',
  ]) {
    assert.equal(D.themeSelector(sel, false, bare), 'root', sel);
  }
});

test('a theme attribute with a value counts on the root only when the root carries it', () => {
  // Algolia DocSearch ships html[data-theme=dark] { --docsearch-... } to every
  // site with its search box (react.dev and vuejs.org don't set data-theme).
  assert.equal(D.themeSelector('html[data-theme="dark"]', false, bare), null);
  assert.equal(D.themeSelector(':root[data-mode="dark"]', false, bare), null);
  // Docusaurus and others: <html data-theme="light">.
  const docs = page({ hasAttr: (n) => n === 'data-theme' });
  assert.equal(D.themeSelector('html[data-theme="dark"]', false, docs), 'root');
  assert.equal(D.themeSelector('html[data-theme="dark"] body', false, docs), 'root');
  // A marked root rule whose marker doesn't count is not a dark media root rule either.
  assert.equal(D.themeSelector('html[data-theme="dark"]', true, bare), null);
});

test('dark styles for sections and components are not a site theme', () => {
  for (const sel of [
    'html[dark] #guide-skeleton', // a component under the theme, not the theme
    '.theme-dark #globalnav', // Apple
    '#globalnav.globalnav-dark',
    'html.globalheader-dark',
    '.bg-dark', // Bootstrap utilities
    '.btn-dark',
    '.navbar-dark',
    '.navbar[data-bs-theme="dark"]',
    '.table-dark',
    '.dark-card',
    '.dark-band',
    '.ytSpecButtonShapeNextOverlayDark', // YouTube button variant
    '.homepage--dark',
    'html[darker-dark-theme] #home-chips',
    '.prose:where(.dark, .dark *)', // Tailwind utility under the variant
    'body:not(.theme-dark)',
    ':root',
    'body',
  ]) {
    assert.equal(D.themeSelector(sel, false, bare), null, sel);
  }
});

test('a bare theme attribute counts only when the root carries it', () => {
  // Bootstrap 5.3 ships [data-bs-theme=dark] to every site.
  assert.equal(D.themeSelector('[data-bs-theme="dark"]', false, bare), null);
  const bs = page({ hasAttr: (n) => n === 'data-bs-theme' });
  assert.equal(D.themeSelector('[data-bs-theme="dark"]', false, bs), 'root-attr');
  // GitHub
  const gh = page({ hasAttr: (n) => ['data-color-mode', 'data-light-theme', 'data-dark-theme'].includes(n) });
  assert.equal(D.themeSelector('[data-color-mode="dark"][data-dark-theme="dark"]', false, gh), 'root-attr');
  assert.equal(D.themeSelector('[data-color-mode][data-color-mode="auto"][data-dark-theme="dark_high_contrast"]', false, gh), 'root-attr');
  // A component carrying the attribute is not the root.
  assert.equal(D.themeSelector('.navbar[data-bs-theme="dark"]', false, bs), null);
});

test('a bare dark class counts only when unused and from a family the root carries', () => {
  // Reddit: body.theme-beta, and .theme-dark defined but on no element.
  const reddit = page({ family: new Set(['theme']) });
  assert.equal(D.themeSelector('.theme-dark', false, reddit), 'root-family');
  // Apple, IKEA, Microsoft: no theme class on the root.
  assert.equal(D.themeSelector('.theme-dark', false, bare), null);
  assert.equal(D.themeSelector('.theme-night', false, bare), null);
  // In use on a section of this page: a section style.
  assert.equal(D.themeSelector('.theme-dark', false, page({ family: new Set(['theme']), dormant: () => false })), null);
  // .dark has no family word to tie it to the root.
  assert.equal(D.themeSelector('.dark', false, reddit), null);
});

test('root colors inside a dark media block', () => {
  assert.equal(D.themeSelector(':root:not(.theme-light)', true, bare), 'media-root'); // Reddit
  assert.equal(D.themeSelector(':root:not([data-theme="light"])', true, bare), 'media-root');
  assert.equal(D.themeSelector('html body', true, bare), 'media-root');
  assert.equal(D.themeSelector('.highlight .k', true, bare), null);
  assert.equal(D.themeSelector(':root', false, bare), null);
});

test('marker names', () => {
  for (const n of ['dark', 'dark-mode', 'darkMode', 'theme-dark', 'theme--dark', 'v-theme--dark', 'is-dark', 'night', 'site-dark', 'skin-theme-clientpref-night']) assert.ok(D.isDarkName(n), n);
  for (const n of ['bg-dark', 'btn-dark', 'text-dark', 'dark-card', 'globalnav-dark', 'darker', 'darken', 'nightlife-banner']) assert.ok(!D.isDarkName(n), n);
});

test('selector splitting keeps brackets, parentheses, strings and escapes together', () => {
  assert.deepEqual(D.splitSelector('html[dark], :root:is(.a, .b), [x="a,b"]', false), ['html[dark]', ':root:is(.a, .b)', '[x="a,b"]']);
  assert.deepEqual(D.splitSelector('html.dark > body .a\\:b', true), ['html.dark', 'body', '.a\\:b']);
  assert.deepEqual(D.splitSelector('li:nth-child(2n + 1) ~ [data-a="x y"]', true), ['li:nth-child(2n + 1)', '[data-a="x y"]']);
});
