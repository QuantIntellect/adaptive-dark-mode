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
   * The page's own background, independent of scrolling: the root canvas,
   * covered by the opaque background of any full-page wrapper (SPA roots such
   * as #app, #__next or #root). Sites that switch theme by restyling only the
   * wrapper (html/body transparent) are seen here. Returns { color, wrappers }.
   *
   * Modal overlays are not the page: a cookie-consent backdrop is a fixed,
   * full-viewport layer stacked above the content (often black at 60%
   * opacity). Fixed layers with a z-index are skipped, and opacity counts
   * toward how opaque a wrapper's background really is.
   */
  function isOverlay(cs) {
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
    const z = parseInt(cs.zIndex, 10);
    return Number.isFinite(z) && z > 0;
  }

  function pageSurface() {
    let color = canvasColor();
    const wrappers = [];
    const body = document.body;
    if (!body) return { color, wrappers };
    const vw = window.innerWidth;
    const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    let el = body;
    let opacity = 1;
    for (let depth = 0; el && depth < 8; depth++) {
      let next = null;
      let nextCs = null;
      for (const child of el.children) {
        if (MEDIA_TAGS.has(child.tagName) || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
        const r = child.getBoundingClientRect();
        if (r.width >= vw * 0.9 && r.height >= docH * 0.6) {
          const cs = getComputedStyle(child);
          if (isOverlay(cs) || cs.visibility === 'hidden') continue;
          next = child;
          nextCs = cs;
          break;
        }
      }
      if (!next) break;
      opacity *= parseFloat(nextCs.opacity) || 0;
      const bg = C.parse(nextCs.backgroundColor);
      if (bg && bg.a * opacity >= 0.9) color = C.composite(bg, color);
      wrappers.push(next);
      el = next;
    }
    return { color, wrappers };
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

  // ---------------------------------------------------------------------------
  // A dark theme of the site's own, switched off right now.
  //
  // Sites that follow the system appearance are already dark in dark mode,
  // and sites that declare color-scheme are left alone (authorScheme). What
  // remains are sites with a theme setting of their own, set to light:
  // YouTube (html[dark]), Stack Overflow (body.theme-dark), Wikipedia
  // (html.skin-theme-clientpref-night), Reddit (:root:not(.theme-light) in a
  // dark media block). Offering to darken those is noise: their own dark
  // theme is one setting away.
  //
  // Evidence, from the page's readable style sheets (cross-origin sheets are
  // not fetched for this: it only decides whether to offer):
  //   root         a rule for the root itself, keyed on a dark marker:
  //                html[dark], body.theme-dark, html.dark body,
  //                :root[data-mode=dark]. A marker with a value
  //                ([data-mode=dark]) counts only when the root carries that
  //                attribute: Algolia DocSearch ships html[data-theme=dark]
  //                to every site that has its search box.
  //   root-attr    a bare [theme-attribute=dark] rule, when <html> or <body>
  //                carries that attribute. Bootstrap 5.3 ships
  //                [data-bs-theme=dark] to every site; only a site that sets
  //                data-bs-theme on its root uses it as a theme.
  //   root-family  a bare dark class that no element has right now, from a
  //                family the root carries (.theme-dark beside
  //                body.theme-beta). A .theme-dark with no theme class on the
  //                root is a style for dark sections (Apple, IKEA), not a
  //                site theme.
  //   media-root   root colors inside @media (prefers-color-scheme: dark),
  //                while that query matches, in a rule that doesn't match the
  //                root: the site's own setting gates them
  //                (:root:not(.theme-light)). A dark block that applies but
  //                only restyles a widget is not a theme.
  // A rule counts only when it sets colors: two or more, three in a dark
  // media block.
  // ---------------------------------------------------------------------------
  const DARK_WORDS = new Set(['dark', 'night']);
  // Words that may stand beside "dark" in a theme marker's name. Anything else
  // makes it a component name: .bg-dark, .btn-dark, .navbar-dark, .dark-card.
  const THEME_WORDS = new Set(['theme', 'themed', 'mode', 'scheme', 'color', 'colour', 'skin', 'appearance', 'clientpref', 'pref', 'prefers', 'is', 'has', 'use', 'ui', 'app', 'site', 'page', 'v', 't', 'global', 'on', 'active', 'enabled']);
  // Words that tie a root class to a theme family (theme-beta ~ theme-dark).
  const FAMILY_WORDS = new Set(['theme', 'themed', 'mode', 'scheme', 'skin', 'appearance', 'color', 'colour', 'clientpref']);
  const THEME_ATTR = /theme|mode|scheme|appearance|colou?r|skin/i;
  const DARK_MEDIA = /prefers-color-scheme\s*:\s*dark/i;
  const ROOT_RE = /^(?:html|body|:root)(?![\w-])/i;
  const NOT_RE = /:not\((?:[^()]|\([^()]*\))*\)/gi;
  const ATTR_RE = /\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*(?:[is]\s*)?)?\]/g;
  const PSEUDO_RE = /::?[\w-]+(?:\((?:[^()]|\([^()]*\))*\))?/g;
  const CLASS_RE = /\.((?:[\w-]|\\.)+)/g;
  const COLORISH = /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)a?\(|^\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+|^\s*\d+(?:\.\d+)?(?:deg)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%|^\s*(?:black|white)\s*$/i;

  /** "skin-theme-clientpref-night" -> [skin, theme, clientpref, night]; "darkMode" -> [dark, mode]. */
  function nameWords(name) {
    return String(name)
      .replace(/\\/g, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .split(/[-_:]+/)
      .filter(Boolean);
  }

  function isDarkName(name) {
    const w = nameWords(name);
    return w.length > 0 && w.length <= 5 && w.some((x) => DARK_WORDS.has(x)) && w.every((x) => DARK_WORDS.has(x) || THEME_WORDS.has(x));
  }

  /** Split at top-level commas (list) or combinators (compounds), outside brackets, parentheses and strings. */
  function splitSelector(sel, compounds) {
    const out = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (let i = 0; i < sel.length; i++) {
      const ch = sel[i];
      if (ch === '\\') {
        cur += ch + (sel[i + 1] || '');
        i++;
        continue;
      }
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (depth === 0 && !quote && (compounds ? /[\s>+~]/.test(ch) : ch === ',')) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  /**
   * One compound selector: { root, bare, marks }. root: it is html, body or
   * :root. bare: it holds nothing but the root type, dark markers, theme
   * attributes and pseudo-classes. marks: its dark markers. :not() is ignored.
   */
  function parseCompound(text) {
    let s = text.replace(NOT_RE, '');
    const root = ROOT_RE.test(s);
    if (root) s = s.replace(ROOT_RE, '');
    const marks = [];
    let other = false;
    s = s.replace(ATTR_RE, (_, name, op, v1, v2, v3) => {
      const value = v1 ?? v2 ?? v3;
      if (THEME_ATTR.test(name)) {
        if (op ? nameWords(value).some((w) => DARK_WORDS.has(w)) : isDarkName(name.replace(/^data-/, ''))) marks.push({ kind: 'attr', name, valued: !!op });
      } else if (!op && isDarkName(name.replace(/^data-/, ''))) {
        marks.push({ kind: 'flag', name }); // [dark]
      } else {
        other = true;
      }
      return '';
    });
    s = s.replace(PSEUDO_RE, '');
    s = s.replace(CLASS_RE, (_, name) => {
      if (isDarkName(name)) marks.push({ kind: 'class', name: name.replace(/\\/g, '') });
      else other = true;
      return '';
    });
    s = s.trim();
    if (s && s !== '*' && s !== '&') other = true;
    return { root, bare: !other, marks };
  }

  /**
   * Classify one complex selector (no commas). `page` describes the root:
   * { hasAttr(name), family: Set of FAMILY_WORDS on root classes, dormant(className) }.
   * Returns 'root' | 'root-attr' | 'root-family' | 'media-root' | null.
   */
  function themeSelector(sel, inDarkMedia, page) {
    const parts = splitSelector(sel, true).map(parseCompound);
    if (!parts.length) return null;
    const subject = parts[parts.length - 1];
    // A marker with a value counts only on a root that carries the attribute.
    const usable = (m) => m.kind !== 'attr' || !m.valued || page.hasAttr(m.name);
    // The root itself: html/body/:root, with only root compounds or bare
    // markers before it (html.dark body, .dark body).
    if (subject.root && parts.every((p) => p.root || (p.bare && p.marks.length))) {
      if (parts.some((p) => p.marks.some(usable))) return 'root';
      if (parts.some((p) => p.marks.length)) return null;
      if (inDarkMedia) return 'media-root';
    }
    if (parts.length !== 1 || !subject.bare) return null;
    for (const m of subject.marks) {
      if (m.kind === 'attr' && page.hasAttr(m.name)) return 'root-attr';
      if (m.kind === 'class' && nameWords(m.name).some((w) => page.family.has(w)) && page.dormant(m.name)) return 'root-family';
    }
    return null;
  }

  function colorCount(style) {
    let n = 0;
    for (let i = 0; i < style.length; i++) {
      const p = style[i];
      const v = style.getPropertyValue(p);
      if (p === 'color-scheme') {
        if (/dark/i.test(v)) n += 2;
      } else if ((p.startsWith('--') || /^(?:background(?:-color)?|color|border(?:-\w+)?-color)$/.test(p)) && COLORISH.test(v)) {
        n++;
      }
    }
    return n;
  }

  /** Returns { via, selector } when the page ships a dark theme of its own, else null. */
  function ownDarkTheme(budget = 60000) {
    const roots = [document.documentElement, document.body].filter(Boolean);
    const family = new Set();
    for (const el of roots) for (const c of el.classList) for (const w of nameWords(c)) if (FAMILY_WORDS.has(w)) family.add(w);
    const page = {
      hasAttr: (name) => roots.some((el) => el.hasAttribute(name)),
      family,
      dormant: (cls) => document.getElementsByClassName(cls).length === 0,
    };
    // A dark media block counts only while it matches (the system is dark).
    const darkNow = (media) => {
      if (!DARK_MEDIA.test(media)) return false;
      try {
        return matchMedia(media).matches;
      } catch (_) {
        return false;
      }
    };
    const appliesToRoot = (sel) => {
      try {
        return roots.some((el) => el.matches(sel));
      } catch (_) {
        return true; // can't tell: not evidence
      }
    };
    let found = null;
    // darkMedia: inside a (prefers-color-scheme: dark) block that matches now.
    const visit = (rules, darkMedia) => {
      for (const rule of rules) {
        if (found || budget-- <= 0) return;
        if (rule instanceof CSSStyleRule) {
          const text = rule.selectorText;
          if ((darkMedia || /dark|night/i.test(text)) && colorCount(rule.style) >= (darkMedia ? 3 : 2)) {
            for (const sel of splitSelector(text, false)) {
              const via = themeSelector(sel, darkMedia, page);
              if (via === 'media-root' && appliesToRoot(sel)) continue;
              if (via) {
                found = { via, selector: sel.slice(0, 120) };
                return;
              }
            }
          }
          if (rule.cssRules && rule.cssRules.length) visit(rule.cssRules, darkMedia);
        } else if (rule instanceof CSSImportRule) {
          let inner = null;
          try {
            inner = rule.styleSheet && rule.styleSheet.cssRules;
          } catch (_) {
            /* cross-origin import */
          }
          if (inner) visit(inner, darkMedia || darkNow(rule.media.mediaText));
        } else if (rule.cssRules) {
          visit(rule.cssRules, darkMedia || (rule instanceof CSSMediaRule && darkNow(rule.media.mediaText)));
        }
      }
    };
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue; // cross-origin
      }
      visit(rules, darkNow(sheet.media ? sheet.media.mediaText : ''));
      if (found || budget <= 0) break;
    }
    return found;
  }

  ADM.detect = {
    authorScheme,
    sampleAppearance,
    backdropAtPoint,
    gradientColor,
    canvasColor,
    pageSurface,
    ownDarkTheme,
    themeSelector,
    isDarkName,
    splitSelector,
    MEDIA_TAGS,
  };
})(globalThis);
