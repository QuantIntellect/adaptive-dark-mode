/*
 * Adaptive Dark Mode — inline styles and legacy presentational attributes.
 *
 * A style="" attribute beats any style sheet rule, so the rule-level engine
 * can't reach it. For each inline color we store the transformed value in a
 * --adm-i-* custom property and list it in data-adm-i; the base sheet maps
 * tokens to !important declarations. Inline custom properties (often set by
 * JS frameworks) get the same role variants as style-sheet ones.
 */
(function (root) {
  'use strict';
  const ADM = root.ADM;
  const T = ADM.transform;
  const C = ADM.color;
  const D = ADM.dom;

  // token -> property
  const INLINE = {
    bgc: 'background-color',
    bgi: 'background-image',
    c: 'color',
    tfc: '-webkit-text-fill-color',
    btc: 'border-top-color',
    brc: 'border-right-color',
    bbc: 'border-bottom-color',
    blc: 'border-left-color',
    bbsc: 'border-block-start-color',
    bbec: 'border-block-end-color',
    bisc: 'border-inline-start-color',
    biec: 'border-inline-end-color',
    oc: 'outline-color',
    bs: 'box-shadow',
    ts: 'text-shadow',
    f: 'fill',
    s: 'stroke',
    tdc: 'text-decoration-color',
    cc: 'caret-color',
    crc: 'column-rule-color',
    tsc: '-webkit-text-stroke-color',
    // shorthands that contained var()
    bg: 'background',
    bd: 'border',
    bdc: 'border-color',
    bdt: 'border-top',
    bdr: 'border-right',
    bdb: 'border-bottom',
    bdl: 'border-left',
    ol: 'outline',
  };
  const TOKEN_OF = Object.fromEntries(Object.entries(INLINE).map(([k, v]) => [v, k]));

  function baseRules() {
    return Object.entries(INLINE)
      .map(([tok, prop]) => `:is([data-adm-i~="${tok}"],${D.BOOST}){${prop}:var(--adm-i-${tok})!important}`)
      .join('');
  }

  class InlineEngine {
    constructor(ctx) {
      this.ctx = ctx; // { model, stats }
      this.important = new WeakMap(); // el -> { prop: [value, priority] } originals we replaced
    }

    processTree(node) {
      if (!node.querySelectorAll) return;
      if (node.nodeType === 1 && (node.hasAttribute('style') || node.hasAttribute('bgcolor') || node.hasAttribute('color') || node.hasAttribute('text'))) {
        this.process(node);
      }
      for (const el of node.querySelectorAll('[style],[bgcolor],font[color],body[text]')) this.process(el);
    }

    process(el) {
      if (!el.style) return;
      if (el.closest('[data-adm-x]')) return this.restore(el);
      const model = this.ctx.model;
      const style = el.style;
      const tokens = [];
      const want = new Map(); // custom prop -> value
      const ctx = { base: document.baseURI };
      let pending = false;

      for (let i = 0; i < style.length; i++) {
        const prop = style[i];
        if (prop.startsWith('--adm-')) continue;
        if (prop.startsWith('--')) {
          const variants = model.defineVariants(prop, style.getPropertyValue(prop), ctx);
          if (variants) for (const [n, v] of variants) want.set(n, v);
          continue;
        }
        const role = T.roleOf(prop);
        if (!role) continue;
        const value = style.getPropertyValue(prop);
        if (!value) {
          pending = true;
          continue;
        }
        const t = model.transformValue(value, role, ctx);
        if (t === value) continue;
        if (style.getPropertyPriority(prop) === 'important') {
          // Inline !important beats every author sheet, so we have to swap the
          // declaration itself (restored on shutdown).
          const saved = this.important.get(el) || {};
          if (!saved[prop]) saved[prop] = value;
          this.important.set(el, saved);
          style.setProperty(prop, t, 'important');
          continue;
        }
        const tok = TOKEN_OF[prop];
        if (!tok) continue;
        tokens.push(tok);
        want.set(`--adm-i-${tok}`, t);
      }
      if (pending) {
        for (const sh of T.VAR_SHORTHANDS) {
          const v = style.getPropertyValue(sh);
          const tok = TOKEN_OF[sh];
          if (!tok || !v || !v.includes('var(')) continue;
          const t = model.transformValue(v, T.roleOf(sh), ctx);
          if (t === v) continue;
          tokens.push(tok);
          want.set(`--adm-i-${tok}`, t);
        }
      }

      // Legacy presentational hints (<td bgcolor>, <font color>, <body text>)
      // only matter when no author rule overrides them.
      const cs = el.hasAttribute('bgcolor') || el.hasAttribute('color') || el.hasAttribute('text') ? getComputedStyle(el) : null;
      const hint = (attr, prop, role, tok) => {
        const raw = el.getAttribute(attr);
        if (!raw || tokens.includes(tok)) return;
        const c = C.parse(raw.startsWith('#') || C.parse(raw) ? raw : '#' + raw);
        const used = C.parse(cs[prop]);
        if (!c || !used) return;
        const t = model.transformColorString(C.format(c), role);
        if (t === C.format(c)) return;
        // The hint is in effect if the used color is the authored one, or our
        // own transform of it (when re-processing, we see our override).
        const u = C.format(used);
        if (u !== C.format(c) && u !== C.format(C.parse(t))) return;
        tokens.push(tok);
        want.set(`--adm-i-${tok}`, t);
      };
      if (cs) {
        hint('bgcolor', 'backgroundColor', 'bg', 'bgc');
        if (el.tagName === 'FONT') hint('color', 'color', 'fg', 'c');
        if (el.tagName === 'BODY') hint('text', 'color', 'fg', 'c');
      }

      // Apply: drop stale custom props, set new ones.
      const stale = [];
      for (let i = 0; i < style.length; i++) {
        const p = style[i];
        if (p.startsWith('--adm-i-') || (p.startsWith('--adm-') && /^--adm-(bg|fg|bd|sh)-/.test(p) && !want.has(p))) {
          if (!want.has(p)) stale.push(p);
        }
      }
      if (!tokens.length && !want.size && !stale.length && !el.hasAttribute('data-adm-i')) return;
      for (const p of stale) style.removeProperty(p);
      for (const [p, v] of want) if (style.getPropertyValue(p) !== v) style.setProperty(p, v);
      if (tokens.length) el.setAttribute('data-adm-i', tokens.join(' '));
      else el.removeAttribute('data-adm-i');
      if (tokens.length) this.ctx.stats.inline = (this.ctx.stats.inline || 0) + 1;
      D.mark(el);
    }

    restore(el) {
      const saved = this.important.get(el);
      if (saved) {
        for (const [prop, value] of Object.entries(saved)) el.style.setProperty(prop, value, 'important');
        this.important.delete(el);
      }
      D.clean(el);
    }

    restoreAll() {
      for (const el of D.touched) {
        const saved = this.important.get(el);
        if (saved) for (const [prop, value] of Object.entries(saved)) el.style.setProperty(prop, value, 'important');
      }
    }
  }

  ADM.InlineEngine = InlineEngine;
  ADM.InlineEngine.baseRules = baseRules;
})(globalThis);
