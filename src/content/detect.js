/*
 * Adaptive Dark Mode — gating and appearance detection.
 *
 * Safari: "For websites that signal support of dark mode with
 * <meta name="color-scheme" content="light dark"> ... or color-scheme: light dark
 * in CSS, Adaptive Dark Mode does not change a thing. For the rest of the web,
 * it quickly analyzes the page, looking at colors and estimating whether it's
 * predominantly light or dark." WebKit runs that detection when the page
 * reaches a visually non-empty state (WebKit commit 5a1e7b740f).
 *
 * All functions here must run with our own style sheets disabled so they see
 * the page as authored.
 */
(function (root) {
  'use strict';
  const ADM = root.ADM;
  const C = ADM.color;

  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'EMBED', 'OBJECT']);

  function tokens(value) {
    return new Set(String(value || '').toLowerCase().split(/[\s,]+/).filter(Boolean));
  }

  /**
   * Does the author declare their own color scheme handling?
   * Returns 'dark' (supports dark: leave alone), 'only' (light only: leave
   * alone) or null.
   */
  function authorScheme() {
    const metas = document.querySelectorAll('meta[name="color-scheme" i], meta[name="supported-color-schemes" i]');
    for (const meta of metas) {
      const t = tokens(meta.content);
      if (t.has('only')) return 'only';
      if (t.has('dark')) return 'dark';
    }
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const t = tokens(getComputedStyle(el).colorScheme);
      if (t.has('only')) return 'only';
      if (t.has('dark')) return 'dark';
    }
    return null;
  }

  function gradientColor(image) {
    // Average of the color stops of the first gradient: a cheap estimate.
    const m = /gradient\((.*)\)/i.exec(image);
    if (!m) return null;
    const found = m[1].match(/(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b[a-z]+\b)/gi) || [];
    let n = 0;
    const acc = { r: 0, g: 0, b: 0, a: 0 };
    for (const f of found) {
      const c = C.parse(f);
      if (!c) continue;
      acc.r += c.r;
      acc.g += c.g;
      acc.b += c.b;
      acc.a += c.a;
      n++;
    }
    return n ? { r: acc.r / n, g: acc.g / n, b: acc.b / n, a: acc.a / n } : null;
  }

  /**
   * The color the canvas is painted with: the root element's background, or —
   * when that is transparent — the body's, which CSS propagates to the canvas.
   */
  function canvasColor(fallback = { r: 1, g: 1, b: 1, a: 1 }) {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const c = C.parse(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0) return C.composite(c, fallback);
    }
    return fallback;
  }

  /**
   * Walk the paint stack under a viewport point (top to bottom) and return
   * either { media: true } or { color } — the composited backdrop color.
   */
  function backdropAtPoint(x, y, skip) {
    const stack = document.elementsFromPoint(x, y);
    let acc = { r: 0, g: 0, b: 0, a: 0 };
    for (const el of stack) {
      if (skip && skip(el)) continue;
      if (MEDIA_TAGS.has(el.tagName)) return { media: el };
      if (el instanceof SVGSVGElement) {
        const r = el.getBoundingClientRect();
        if (r.width * r.height > 40000) return { media: el };
        continue;
      }
      if (el instanceof SVGElement) continue;
      const cs = getComputedStyle(el);
      const image = cs.backgroundImage;
      if (image && image !== 'none') {
        if (image.includes('url(')) return { media: el };
        const g = gradientColor(image);
        if (g) acc = C.composite(acc, g);
      }
      const bg = C.parse(cs.backgroundColor);
      if (bg && bg.a > 0) acc = C.composite(acc, bg);
      if (acc.a >= 0.99) return { color: acc, element: el };
    }
    // Reached the canvas.
    return { color: C.composite(acc, canvasColor()), element: null };
  }

  /**
   * Sample the rendered page. Returns { verdict: 'light'|'dark'|'empty', ... }.
   */
  function sampleAppearance() {
    const body = document.body;
    if (!body) return { verdict: 'empty' };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!vw || !vh) return { verdict: 'empty' };

    const bgY = [];
    let mediaPoints = 0;
    const N = 7;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = ((i + 0.5) / N) * vw;
        const y = ((j + 0.5) / N) * vh;
        const hit = backdropAtPoint(x, y);
        if (hit.media) mediaPoints++;
        else bgY.push(C.luminance(hit.color));
      }
    }

    // Text sample: weight visible text by length.
    let textWeight = 0;
    let textYSum = 0;
    let textNodes = 0;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeValue.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode() && textNodes < 400) {
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.closest('script,style,noscript,template')) continue;
      const rect = parent.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > vh * 2) continue;
      const c = C.parse(getComputedStyle(parent).color);
      if (!c) continue;
      const w = Math.min(200, walker.currentNode.nodeValue.trim().length);
      textWeight += w;
      textYSum += C.luminance(c) * w;
      textNodes++;
    }
    const textY = textWeight ? textYSum / textWeight : null;

    if (bgY.length < 3 && textY === null) return { verdict: 'empty', mediaPoints };

    const sorted = bgY.slice().sort((a, b) => a - b);
    const medianBgY = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const lightFrac = sorted.length ? sorted.filter((y) => y > 0.4).length / sorted.length : 0;

    let verdict;
    if (medianBgY === null) verdict = textY !== null && textY < 0.25 ? 'light' : 'dark';
    else if (lightFrac >= 0.5) verdict = 'light';
    else if (medianBgY < 0.2 && (textY === null || textY > 0.25)) verdict = 'dark';
    else verdict = medianBgY > 0.3 ? 'light' : 'dark';

    // A page with almost nothing painted yet (SPA shell) is not decided.
    if (textNodes === 0 && mediaPoints === 0 && body.getBoundingClientRect().height < 20) verdict = 'empty';

    return { verdict, medianBgY, lightFrac, textY, mediaPoints, samples: bgY.length };
  }

  ADM.detect = { authorScheme, sampleAppearance, backdropAtPoint, gradientColor, canvasColor, MEDIA_TAGS };
})(globalThis);
