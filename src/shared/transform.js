/*
 * Adaptive Dark Mode — the color transform model.
 *
 * WebKit's ADM decides, per painted color, whether to invert it or leave it
 * alone, and aims for WCAG 4.5:1 text contrast. The engine itself is closed
 * source (WebKitAdditions), so this model is *fitted* to WebKit's published
 * before/after screenshots (see docs/how-safari-does-it.md):
 *
 *   - Neutral / tinted colors are "flipped" with a contrast-preserving
 *     luminance inversion:  Y' + 0.05 = k / (Y + 0.05)
 *     where k pins white to the chosen dark anchor (#1e1e1e by default, the
 *     value WebKit's Interop screenshot shows for a white page). Because the
 *     map is an involution in (Y + 0.05) space, every WCAG contrast ratio
 *     between two flipped colors is preserved exactly — the card/page
 *     separation Safari keeps (1.163 -> 1.17 measured) falls out naturally.
 *     Hue and chroma are kept in OKLCH (gamut-clamped).
 *   - Vivid colors (OKLCH chroma >= 0.08) carry meaning (badges, brand
 *     buttons, links) and keep their hue: surfaces stay as they are (very
 *     light ones are dimmed a little), text is lightened just enough to
 *     reach the contrast target (Safari: #4470e2 link -> Y 0.229; model 0.234).
 *   - Already-dark surfaces are left alone (Safari keeps large dark cards);
 *     dark text becomes light, light text is left for the layout pass to
 *     judge against its real backdrop.
 */
(function (root) {
  'use strict';
  const ADM = root.ADM || (root.ADM = {});
  const C = ADM.color;

  const DEPTH_ANCHORS = {
    soft: '#333333', // Apple's 2018 -apple-invert-lightness() white point
    standard: '#1e1e1e', // white page in WebKit's Interop ADM screenshot
    deep: '#141414',
    oled: '#000000',
  };

  const VIVID_C = 0.08; // OKLCH chroma above which a surface/border color is "semantic"
  // Text is only kept (and minimally lightened) when strongly chromatic, like
  // links. Safari flips dark green/orange text (C ~0.09-0.12) to light tints
  // but keeps #4470e2-style link blues (C ~0.18) near 4.5:1.
  const VIVID_TEXT_C = 0.15;
  const LOW_ALPHA_TINT = 0.2; // translucent dark overlays below this flip to light tints
  const BORDER_MAX_Y = 0.35; // flipped dark borders stop at a mid gray, never glaring
  const MAX_Y = 0.9; // never output pure white text (Safari's lands at ~0.93-0.96)

  // ---------------------------------------------------------------------------
  // Property -> role mapping
  // ---------------------------------------------------------------------------
  const BORDER_COLOR_RE = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-color$/;
  function roleOf(prop) {
    switch (prop) {
      case 'background-color':
      case 'background-image':
      case 'background':
        return 'bg';
      case 'color':
      case '-webkit-text-fill-color':
      case 'caret-color':
      case 'text-decoration-color':
      case 'text-emphasis-color':
      case '-webkit-text-stroke-color':
      case 'text-decoration':
      case 'text-emphasis':
      case '-webkit-text-stroke':
      case 'fill':
      case 'stroke':
        return 'fg';
      case 'outline-color':
      case 'outline':
      case 'column-rule-color':
      case 'column-rule':
      case 'scrollbar-color':
      case 'border':
      case 'border-color':
      case 'border-top':
      case 'border-right':
      case 'border-bottom':
      case 'border-left':
      case 'border-block':
      case 'border-inline':
      case 'border-block-start':
      case 'border-block-end':
      case 'border-inline-start':
      case 'border-inline-end':
        return 'bd';
      case 'box-shadow':
      case 'text-shadow':
        return 'sh';
      default:
        return BORDER_COLOR_RE.test(prop) ? 'bd' : null;
    }
  }

  // Shorthands whose longhands become "pending substitution" (empty) when the
  // shorthand contains var(); we must rewrite the shorthand itself.
  const VAR_SHORTHANDS = [
    'background', 'border', 'border-color', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-block', 'border-inline', 'border-block-start', 'border-block-end', 'border-inline-start',
    'border-inline-end', 'outline', 'column-rule', 'text-decoration', 'text-emphasis', '-webkit-text-stroke',
  ];

  // Blend modes whose result depends on the backdrop being light. Safari turns
  // such effects off "in some cases" on transformed content; we turn these off.
  const BLEND_OFF = new Set(['multiply', 'screen', 'darken', 'lighten', 'color-burn', 'color-dodge']);

  // ---------------------------------------------------------------------------
  // Generic CSS value helpers
  // ---------------------------------------------------------------------------
  function splitTopLevel(str, sep = ',') {
    const out = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === sep && depth === 0) {
        out.push(str.slice(start, i));
        start = i + 1;
      }
    }
    out.push(str.slice(start));
    return out;
  }

  /** Index of the ")" matching the "(" at `open`. */
  function matchParen(str, open) {
    let depth = 0;
    let quote = null;
    for (let i = open; i < str.length; i++) {
      const ch = str[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return str.length - 1;
  }

  const isIdentStart = (ch) => /[a-zA-Z_\-\u0080-\uffff]/.test(ch);
  const isIdentChar = (ch) => /[a-zA-Z0-9_\-\u0080-\uffff]/.test(ch);

  function absolutize(raw, base) {
    if (!base) return raw;
    const m = /^url\(\s*(['"]?)(.*?)\1\s*\)$/is.exec(raw);
    if (!m) return raw;
    const u = m[2];
    if (!u || /^(data:|blob:|#|[a-z][a-z0-9+.-]*:)/i.test(u)) return raw;
    try {
      return `url("${new URL(u, base).href}")`;
    } catch (_) {
      return raw;
    }
  }

  // Patterns used by design systems that store color *channels* in variables:
  //   shadcn/ui:   --background: 0 0% 100%;      used as hsl(var(--background))
  //   Bootstrap:   --bs-body-bg-rgb: 255, 255, 255; used as rgba(var(--bs-body-bg-rgb), .5)
  const HSL_TRIPLET = /^(-?\d*\.?\d+)(deg)?\s+(\d*\.?\d+)%\s+(\d*\.?\d+)%$/;
  const RGB_TRIPLET = /^(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})$/;

  // ---------------------------------------------------------------------------
  // The model
  // ---------------------------------------------------------------------------
  function createModel(opts = {}) {
    const depth = DEPTH_ANCHORS[opts.depth] ? opts.depth : 'standard';
    const anchor = C.parse(DEPTH_ANCHORS[depth]);
    const Ya = C.luminance(anchor);
    const k = 1.05 * (Ya + 0.05);
    const pivotY = Math.sqrt(k) - 0.05;
    const textTarget = Number(opts.textContrast) > 1 ? Number(opts.textContrast) : 4.5;

    const reverse = new Map(); // transformed css color -> original css color
    const colorCache = new Map();
    const valueCache = new Map();

    const flipY = (Y) => C.clamp(k / (Y + 0.05) - 0.05, 0, MAX_Y);
    // Neutral text is checked against a typical flipped panel (a #e8e8e8-ish
    // light surface after the flip), not only the darkest base, so it stays
    // legible on cards and sidebars without per-element fixes.
    const textRef = C.withLuminance({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, flipY(0.82));
    const flip = (c, maxY = MAX_Y) => {
      const Y = C.luminance(c);
      return C.withLuminance(c, Math.min(flipY(Y), maxY));
    };
    const chroma = (c) => C.toOklch(C.clampColor(c)).C;

    /** Make `fg` reach `target` contrast against opaque `bg`, keeping hue. */
    function ensureContrast(fg, bg, target = textTarget) {
      const eff = fg.a < 1 ? C.composite(fg, bg) : fg;
      const Yf = C.luminance(eff);
      const Yb = C.luminance(bg);
      if (C.contrastY(Yf, Yb) >= target - 0.01) return fg;
      const needLight = (Yb + 0.05) * target - 0.05;
      const needDark = (Yb + 0.05) / target - 0.05;
      const preferLight = Yf >= Yb;
      let Y;
      if (preferLight) Y = needLight <= 1 ? needLight : needDark >= 0 ? needDark : null;
      else Y = needDark >= 0 ? needDark : needLight <= 1 ? needLight : null;
      if (Y === null) Y = C.contrastY(1, Yb) >= C.contrastY(0, Yb) ? 1 : 0;
      return C.withLuminance({ ...eff, a: 1 }, Y);
    }

    function dimVivid(c) {
      const Y = C.luminance(c);
      return Y > 0.35 ? C.withLuminance(c, 0.35 + (Y - 0.35) * 0.6) : c;
    }

    /**
     * Transform one concrete color for a role.
     *   bg — surfaces, gradients    fg — text, icons, decorations
     *   bd — borders, outlines, ring shadows    sh — drop shadows
     */
    function transformColor(c, role) {
      if (c.a <= 0) return c;
      const vivid = chroma(c) >= VIVID_C;
      const Y = C.luminance(c);
      switch (role) {
        case 'bg': {
          if (vivid && !(Y > 0.6 && chroma(c) < 0.14)) return dimVivid(c);
          if (Y > pivotY || c.a < LOW_ALPHA_TINT) return flip(c);
          return c; // already-dark surfaces stay dark
        }
        case 'fg': {
          if (chroma(c) >= VIVID_TEXT_C) return ensureContrast(c, anchor);
          if (Y < pivotY) {
            const out = flip(c);
            return out.a < 1 ? out : ensureContrast(out, textRef);
          }
          // Mid grays (secondary text on light pages) sit near the pivot, where
          // the flip barely moves them; make sure they read on dark surfaces.
          // Lighter text is left for the layout pass to judge.
          return Y < 0.5 ? ensureContrast(c, textRef) : c;
        }
        case 'bd': {
          if (vivid) return c;
          return flip(c, Y < pivotY ? BORDER_MAX_Y : MAX_Y);
        }
        case 'sh': {
          if (vivid) return c;
          return Y > pivotY ? flip(c) : c; // dark shadows stay shadows
        }
        default:
          return c;
      }
    }

    function transformColorString(str, role) {
      const key = role + '|' + str;
      let out = colorCache.get(key);
      if (out !== undefined) return out;
      const c = C.parse(str);
      if (!c) out = str;
      else {
        const t = transformColor(c, role);
        out = t === c ? str : C.format(t);
        if (out !== str && (role === 'fg' || role === 'bg')) reverse.set(out, C.format(c));
      }
      if (colorCache.size > 50000) colorCache.clear();
      colorCache.set(key, out);
      return out;
    }

    const varName = (role, name) => `--adm-${role}-${name.slice(2)}`;

    function rewriteVar(args, role, ctx) {
      const parts = splitTopLevel(args, ',');
      const name = parts[0].trim();
      if (!name.startsWith('--')) return `var(${args})`;
      const fallback = parts.length > 1 ? parts.slice(1).join(',') : null;
      const inner = fallback === null ? `var(${name})` : `var(${name},${walk(fallback, role, ctx)})`;
      return `var(${varName(role, name)}, ${inner})`;
    }

    // Color function with var() inside: rgb(255 255 255 / var(--tw-bg-opacity)),
    // hsl(var(--background)), rgb(from var(--x) r g b / 50%)...
    function colorFunctionWithVar(name, body, role, ctx) {
      const lower = body.trim().toLowerCase();
      if (lower.startsWith('from ')) return `${name}(${walk(body, role, ctx)})`;
      const slash = splitTopLevel(body, '/');
      if (slash.length === 2 && !slash[0].includes('var(')) {
        const base = C.parse(`${name}(${slash[0]})`);
        if (base) {
          const t = transformColor(base, role);
          const ch = C.clampColor(t);
          const triplet = `${Math.round(ch.r * 255)} ${Math.round(ch.g * 255)} ${Math.round(ch.b * 255)}`;
          return `rgb(${triplet} / ${slash[1].trim()})`;
        }
      }
      return `${name}(${walk(body, role, ctx)})`;
    }

    /** Transform every color token in an arbitrary CSS value. */
    function walk(str, role, ctx) {
      let out = '';
      let i = 0;
      const n = str.length;
      while (i < n) {
        const ch = str[i];
        if (ch === '"' || ch === "'") {
          let j = i + 1;
          while (j < n && str[j] !== ch) j += str[j] === '\\' ? 2 : 1;
          out += str.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        if (ch === '#') {
          let j = i + 1;
          while (j < n && /[0-9a-fA-F]/.test(str[j])) j++;
          const len = j - i - 1;
          if ((len === 3 || len === 4 || len === 6 || len === 8) && !(j < n && isIdentChar(str[j]))) {
            out += transformColorString(str.slice(i, j), role);
          } else {
            out += str.slice(i, j);
          }
          i = j;
          continue;
        }
        if (/[0-9.]/.test(ch)) {
          let j = i + 1;
          while (j < n && /[0-9a-zA-Z.%+]/.test(str[j]) && !(str[j] === '+' && !/e/i.test(str[j - 1]))) j++;
          out += str.slice(i, j);
          i = j;
          continue;
        }
        if (isIdentStart(ch) && !(ch === '-' && /[0-9.]/.test(str[i + 1] || ''))) {
          let j = i + 1;
          while (j < n && isIdentChar(str[j])) j++;
          const ident = str.slice(i, j);
          const lower = ident.toLowerCase();
          if (str[j] === '(') {
            const close = matchParen(str, j);
            const body = str.slice(j + 1, close);
            if (lower === 'url') out += absolutize(str.slice(i, close + 1), ctx && ctx.base);
            else if (lower === 'var') out += rewriteVar(body, role, ctx);
            else if (lower === 'light-dark' || lower === 'env' || lower === 'attr') out += str.slice(i, close + 1);
            else if (C.COLOR_FUNCS.has(lower)) {
              if (body.includes('var(') || /\bfrom\b/i.test(body)) out += colorFunctionWithVar(lower, body, role, ctx);
              else out += transformColorString(str.slice(i, close + 1), role);
            } else {
              out += `${ident}(${walk(body, role, ctx)})`;
            }
            i = close + 1;
            continue;
          }
          if (C.NAMED[lower]) out += transformColorString(lower, role);
          else out += ident;
          i = j;
          continue;
        }
        out += ch;
        i++;
      }
      return out;
    }

    const LENGTH_RE = /^-?(\d*\.?\d+)(px|em|rem|ex|ch|vw|vh|vmin|vmax|pt|pc|cm|mm|in|q|%)?$/i;
    function transformShadowList(value, ctx) {
      if (/^\s*none\s*$/i.test(value)) return value;
      return splitTopLevel(value, ',')
        .map((part) => {
          const tokens = splitTopLevel(part.trim(), ' ').filter(Boolean);
          const lengths = [];
          for (const t of tokens) {
            if (LENGTH_RE.test(t)) lengths.push(parseFloat(t));
            else if (/^calc\(/i.test(t)) lengths.push(NaN);
          }
          const ring = lengths.length >= 2 && lengths[0] === 0 && lengths[1] === 0 && (lengths.length < 3 || lengths[2] === 0);
          return ' ' + walk(part.trim(), ring ? 'bd' : 'sh', ctx);
        })
        .join(',')
        .trim();
    }

    /** Transform a declaration value for a role. Cached. */
    function transformValue(value, role, ctx) {
      if (!value) return value;
      const base = ctx && ctx.base && value.includes('url(') ? ctx.base : '';
      const key = role + '|' + base + '|' + value;
      let out = valueCache.get(key);
      if (out !== undefined) return out;
      out = role === 'sh' ? transformShadowList(value, ctx) : walk(value, role, ctx);
      if (valueCache.size > 50000) valueCache.clear();
      valueCache.set(key, out);
      return out;
    }

    const COLORISH_RE = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(|var\(|\btransparent\b|\bcurrentcolor\b/i;
    function hasNamedColor(value) {
      const idents = value.toLowerCase().match(/[a-z]+/g);
      return !!idents && idents.some((w) => C.NAMED[w]);
    }

    /**
     * For a custom property definition, return the role-specific variants we
     * define next to it ([[name, value], ...]) or null if it carries no color.
     * Every color-role use of var(--x) is rewritten to
     * var(--adm-<role>-x, var(--x)), so variables used for both text and
     * surfaces get the right transform at each use site.
     */
    const ROLES = ['bg', 'fg', 'bd', 'sh'];
    function defineVariants(name, rawValue, ctx) {
      const value = rawValue.trim();
      if (!value || name.startsWith('--adm-')) return null;
      let m = HSL_TRIPLET.exec(value);
      if (m) {
        const base = C.parse(`hsl(${m[1]}${m[2] || ''} ${m[3]}% ${m[4]}%)`);
        if (!base) return null;
        return ROLES.map((role) => {
          const t = C.clampColor(transformColor(base, role));
          const [h, s, l] = C.rgbToHsl(t.r, t.g, t.b);
          return [varName(role, name), `${+h.toFixed(1)}${m[2] || ''} ${+(s * 100).toFixed(1)}% ${+(l * 100).toFixed(1)}%`];
        });
      }
      m = RGB_TRIPLET.exec(value);
      if (m) {
        const base = C.parse(`rgb(${m[1]} ${m[3]} ${m[4]})`);
        if (!base) return null;
        const sep = m[2].includes(',') ? ', ' : ' ';
        return ROLES.map((role) => {
          const t = C.clampColor(transformColor(base, role));
          return [varName(role, name), [t.r, t.g, t.b].map((v) => Math.round(v * 255)).join(sep)];
        });
      }
      if (!COLORISH_RE.test(value) && !hasNamedColor(value)) return null;
      // Emitted even when unchanged (e.g. a vivid color or `transparent`):
      // a later definition must override an earlier, transformed one.
      return ROLES.map((role) => [varName(role, name), transformValue(value, role, ctx)]);
    }

    /** Variants for a definition of a color variable whose value here isn't a color. */
    function passThroughVariants(name, rawValue, ctx) {
      const value = rawValue.trim();
      if (name.startsWith('--adm-')) return null;
      return ROLES.map((role) => [varName(role, name), value.includes('var(') ? transformValue(value, role, ctx) : value || 'initial']);
    }

    return {
      depth,
      anchor,
      anchorCss: C.format(anchor),
      pivotY,
      textTarget,
      reverse,
      flip,
      flipY,
      ensureContrast,
      transformColor,
      transformColorString,
      transformValue,
      defineVariants,
      passThroughVariants,
      isVivid: (c) => chroma(c) >= VIVID_C,
      original: (css) => reverse.get(css) || css,
    };
  }

  // ---------------------------------------------------------------------------
  // Selector helper: exclude author-managed subtrees without changing
  // specificity (:where() contributes 0).
  // ---------------------------------------------------------------------------
  const EXCLUDE = ':not(:where([data-adm-x],[data-adm-x] *))';
  function addExclusion(selectorText) {
    return splitTopLevel(selectorText, ',')
      .map((sel) => {
        const s = sel.trim();
        if (!s || /^(:root|html|:host)\b/i.test(s)) return s;
        // Insert before a trailing pseudo-element (::x or legacy :before/:after...).
        let depth = 0;
        let quote = null;
        let pe = -1;
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
          }
          if (ch === '"' || ch === "'") quote = ch;
          else if (ch === '(' || ch === '[') depth++;
          else if (ch === ')' || ch === ']') depth--;
          else if (depth === 0 && ch === ':' && s[i + 1] === ':') {
            pe = i;
            break;
          }
        }
        if (pe === -1) {
          const legacy = /:(before|after|first-line|first-letter)$/i.exec(s);
          if (legacy) pe = legacy.index;
        }
        return pe === -1 ? s + EXCLUDE : s.slice(0, pe) + EXCLUDE + s.slice(pe);
      })
      .join(',');
  }

  ADM.transform = {
    DEPTH_ANCHORS,
    VIVID_C,
    VIVID_TEXT_C,
    VAR_SHORTHANDS,
    BLEND_OFF,
    roleOf,
    splitTopLevel,
    matchParen,
    createModel,
    addExclusion,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
