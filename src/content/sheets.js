/*
 * Adaptive Dark Mode — style-sheet engine.
 *
 * Safari transforms colors inside the engine's style adjuster (StyleAdjuster::
 * adjustForAXCustomColorMode) so :hover, ::before, class toggles and dynamic
 * content are all covered. An extension can only get the same coverage at the
 * rule level: for every author rule that sets a color we emit an override rule
 * with the *same selector* in the *same at-rule context* (media, supports,
 * layer, container, scope, nesting), placed after the page's sheets via
 * adoptedStyleSheets. Equal specificity + later order = our value wins, and
 * the page's own cascade between rules is preserved.
 */
(function (root) {
  'use strict';
  const ADM = root.ADM;
  const T = ADM.transform;

  const ourSheets = new WeakSet();
  const has = (name) => typeof root[name] === 'function';

  function makeSheet() {
    const s = new CSSStyleSheet();
    ourSheets.add(s);
    return s;
  }

  function preludeOf(rule) {
    const text = rule.cssText;
    const brace = text.indexOf('{');
    return brace === -1 ? null : text.slice(0, brace).trim();
  }

  const PRINT_ONLY = /^\s*print\s*$/i;
  const AUTHOR_DARK = /prefers-color-scheme\s*:\s*dark/i;
  const OS_DARK = typeof root.matchMedia === 'function' ? root.matchMedia('(prefers-color-scheme: dark)') : { matches: false }; // Node (unit tests)
  /** A media condition that selects the author's own dark design. */
  const isAuthorDark = (m) => !!m && AUTHOR_DARK.test(m) && !/\bnot\b/i.test(m);
  /**
   * We only run while presenting the page dark. If the system is light, the
   * author's dark rules don't match: switch them on by replacing the
   * prefers-color-scheme test with an always-true one, so sites with their own
   * dark CSS get their own dark design instead of our conversion.
   */
  const darkMedia = (m) => (isAuthorDark(m) && !OS_DARK.matches ? m.replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, '(min-width: 0px)') : m);

  // ---------------------------------------------------------------------------
  // Source-text fallback. When a var() shorthand is followed by one of its own
  // longhands (`background: var(--x); background-size: cover`), CSSOM and the
  // Typed OM both report the shorthand as "" — the authored value is gone. We
  // then index the sheet's source text by selector and recover it from there.
  // ---------------------------------------------------------------------------
  function normSelector(sel) {
    return sel
      .replace(/\s+/g, ' ')
      .replace(/\s*([>+~,])\s*/g, '$1')
      .replace(/(^|[^:]):(before|after|first-line|first-letter)\b/gi, '$1::$2')
      .replace(/=\s*(["'])(.*?)\1\s*\]/g, '=$2]')
      .trim();
  }

  function indexSource(text) {
    const map = new Map();
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');
    const stack = [];
    let boundary = 0;
    let quote = null;
    let paren = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') paren++;
      else if (ch === ')') paren--;
      else if (paren > 0) continue;
      else if (ch === '{') {
        stack.push({ prelude: text.slice(boundary, i).trim(), start: i + 1 });
        boundary = i + 1;
      } else if (ch === '}') {
        const frame = stack.pop();
        if (frame && frame.prelude && frame.prelude[0] !== '@') {
          const key = normSelector(frame.prelude);
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(text.slice(frame.start, i));
        }
        boundary = i + 1;
      } else if (ch === ';') boundary = i + 1;
    }
    return map;
  }

  function declarationsOf(body) {
    const out = [];
    let depth = 0;
    let start = 0;
    let quote = null;
    for (let i = 0; i <= body.length; i++) {
      const ch = body[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') depth--;
      else if ((ch === ';' || ch === undefined) && depth === 0) {
        const seg = body.slice(start, i);
        start = i + 1;
        const colon = seg.indexOf(':');
        if (colon === -1 || seg.includes('{')) continue;
        let value = seg.slice(colon + 1).trim();
        const important = /!\s*important\s*$/i.test(value);
        if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
        out.push({ prop: seg.slice(0, colon).trim().toLowerCase(), value, important });
      }
    }
    return out;
  }

  class SheetEngine {
    /**
     * @param {{ model: object, fetchText: (url:string)=>Promise<string|null>,
     *           onExclusions: (selectors:string[])=>void, stats: object }} ctx
     */
    constructor(ctx) {
      this.ctx = ctx;
      this.entries = new Map(); // source CSSStyleSheet -> { override, sig, root }
      this.roots = new Set();
      this.fetched = new Map(); // absolute href -> { status, sheet }
      this.exclusions = new Set();
      this.useExclusion = false;
      this.baseSheet = null;
      this.disabled = false;
      this.syncQueued = false;
      this.lastBuildMs = 0;
      this.totalMs = 0; // cumulative main-thread time spent building overrides
      this.syncCount = 0;
      this.sources = new WeakMap(); // sheet -> Map(normalized selector -> [block text])
      // Custom properties that carry a color somewhere. Every definition of
      // such a name gets role variants (pass-through when not a color), so
      // the variants cascade exactly like the variable itself.
      this.colorVars = new Set();
      this.varsGrew = false;
      this.sourceRequested = new WeakSet();
    }

    static isOurs(sheet) {
      return ourSheets.has(sheet);
    }
    static makeSheet() {
      return makeSheet();
    }

    setModel(model) {
      this.ctx.model = model;
      this.rebuildAll();
    }

    setBaseSheet(sheet) {
      this.baseSheet = sheet;
      for (const r of this.roots) this.updateAdopted(r);
    }

    addRoot(r) {
      if (this.roots.has(r)) return;
      this.roots.add(r);
      this.sync(r);
    }

    scheduleSync() {
      if (this.syncQueued) return;
      this.syncQueued = true;
      queueMicrotask(() => {
        this.syncQueued = false;
        this.syncAll();
      });
    }

    syncAll() {
      for (let round = 0; round < 2; round++) {
        this.varsGrew = false;
        for (const r of this.roots) {
          if (r !== document && !r.host?.isConnected) {
            this.roots.delete(r);
            continue;
          }
          this.sync(r);
        }
        // A variable first seen as a color in a later sheet: earlier sheets
        // must now emit its variants too. Rebuild once.
        if (!this.varsGrew) break;
        for (const e of this.entries.values()) e.sig = null;
      }
    }

    rebuildAll() {
      for (const e of this.entries.values()) e.sig = null;
      this.syncAll();
    }

    setDisabled(disabled) {
      this.disabled = disabled;
      for (const e of this.entries.values()) e.override.disabled = disabled;
      if (this.baseSheet) this.baseSheet.disabled = disabled;
    }

    stop() {
      for (const r of this.roots) {
        try {
          r.adoptedStyleSheets = r.adoptedStyleSheets.filter((s) => !ourSheets.has(s));
        } catch (_) {
          /* root gone */
        }
      }
      this.entries.clear();
      this.roots.clear();
    }

    // -------------------------------------------------------------------------
    sourcesOf(r) {
      const list = [];
      for (const s of r.styleSheets) list.push(s);
      for (const s of r.adoptedStyleSheets) if (!ourSheets.has(s)) list.push(s);
      return list;
    }

    signature(sheet) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        const f = this.fetched.get(this.abs(sheet.href));
        return (OS_DARK.matches ? 'D' : 'L') + 'xo|' + (f ? f.status : 'none');
      }
      const n = rules.length;
      const last = n ? rules[n - 1] : null;
      const first = n ? rules[0] : null;
      return `${OS_DARK.matches ? 'D' : 'L'}${sheet.disabled ? 1 : 0}|${n}|${sheet.media ? sheet.media.mediaText : ''}|${last ? last.selectorText || last.type : ''}|${first ? first.selectorText || first.type : ''}`;
    }

    sync(r) {
      // Building a sheet can trigger callbacks (exclusions, source text) that
      // ask for another sync. Never nest: a nested build would be overwritten
      // by the outer one's stale result. Defer instead.
      if (this.syncing) {
        this.resync = true;
        return;
      }
      this.syncing = true;
      try {
        this.syncRoot(r);
      } finally {
        this.syncing = false;
      }
      if (this.resync) {
        this.resync = false;
        this.scheduleSync();
      }
    }

    syncRoot(r) {
      const t0 = performance.now();
      let sources;
      try {
        sources = this.sourcesOf(r);
      } catch (_) {
        return;
      }
      const live = new Set(sources);
      let rebuilt = 0;
      for (const [src, e] of this.entries) {
        if (e.root === r && !live.has(src)) this.entries.delete(src);
      }
      for (const src of sources) {
        const sig = this.signature(src);
        let e = this.entries.get(src);
        if (e && e.sig === sig) continue;
        if (!e) {
          e = { override: makeSheet(), sig: null, root: r };
          this.entries.set(src, e);
        }
        e.sig = sig;
        rebuilt++;
        let css = '';
        const ctx = { pending: false };
        try {
          css = src.disabled ? '' : this.build(src, ctx);
        } catch (err) {
          css = '';
        }
        e.pendingImport = ctx.pending;
        e.rules = ctx.rules || 0;
        try {
          e.override.replaceSync(css);
        } catch (_) {
          e.override.replaceSync('');
        }
        e.override.disabled = this.disabled;
      }
      this.updateAdopted(r, sources);
      this.lastBuildMs = performance.now() - t0;
      this.totalMs += this.lastBuildMs;
      this.syncCount++;
      let rulesTotal = 0;
      let sheetsTotal = 0;
      for (const e of this.entries.values()) {
        rulesTotal += e.rules || 0;
        if (e.rules) sheetsTotal++;
      }
      this.ctx.stats.rules = rulesTotal;
      this.ctx.stats.sheets = sheetsTotal;
      // Overrides that land after the layout pass (cross-origin CSS, recovered
      // source text, insertRule) change backdrops: re-check what is on screen.
      if (rebuilt && this.ctx.onSheetsChanged) this.ctx.onSheetsChanged();
    }

    updateAdopted(r, sources) {
      sources = sources || this.sourcesOf(r);
      const ours = [];
      for (const src of sources) {
        const e = this.entries.get(src);
        if (e && e.root === r) ours.push(e.override);
      }
      if (this.baseSheet) ours.push(this.baseSheet);
      const current = r.adoptedStyleSheets;
      const page = current.filter((s) => !ourSheets.has(s));
      const next = page.concat(ours);
      if (next.length === current.length && next.every((s, i) => s === current[i])) return;
      try {
        r.adoptedStyleSheets = next;
      } catch (_) {
        /* e.g. sheets from another document */
      }
    }

    // -------------------------------------------------------------------------
    abs(href, base) {
      try {
        return new URL(href, base || document.baseURI).href;
      } catch (_) {
        return href;
      }
    }

    build(src, state) {
      const ctx = { base: src.href || document.baseURI, ns: [], state, source: this.sources.get(src) || null, seen: new Map(), needsSource: false, rules: 0 };
      let rules;
      let fetched = null;
      try {
        rules = src.cssRules;
      } catch (_) {
        fetched = this.fetchSheet(this.abs(src.href));
        if (fetched.status !== 'done') return '';
        rules = fetched.sheet.cssRules;
        ctx.base = this.abs(src.href);
      }
      const media = src.media ? src.media.mediaText : '';
      if (isAuthorDark(media)) ctx.authorDark = true;
      let css = this.walk(rules, ctx);
      state.rules = ctx.rules;
      if (ctx.needsSource && !ctx.source) this.requestSource(src, fetched);
      if (!css) return '';
      if (media) {
        if (PRINT_ONLY.test(media)) return '';
        css = `@media ${darkMedia(media)}{${css}}`;
      }
      // Safari disables ADM while printing (WebKit commit f3a15c44e7).
      return ctx.ns.join('') + `@media screen{${css}}`;
    }

    requestSource(src, fetched) {
      if (this.sourceRequested.has(src)) return;
      this.sourceRequested.add(src);
      const done = (text) => {
        if (typeof text !== 'string') return;
        this.sources.set(src, indexSource(text));
        const e = this.entries.get(src);
        if (e) e.sig = null;
        this.scheduleSync();
      };
      if (fetched && fetched.text) return done(fetched.text);
      const owner = src.ownerNode;
      if (owner && owner.nodeName === 'STYLE') return done(owner.textContent);
      if (src.href) this.ctx.fetchText(this.abs(src.href)).then(done, () => {});
    }

    /** Recover var() declarations that CSSOM lost, from the source text. */
    fromSource(style, ctx) {
      ctx.needsSource = true;
      if (!ctx.source || !ctx.selector) return '';
      const key = normSelector(ctx.selector);
      const blocks = ctx.source.get(key);
      if (!blocks) return '';
      const n = ctx.seen.get(key) || 0;
      const body = blocks[Math.min(n, blocks.length - 1)];
      let out = '';
      for (const d of declarationsOf(body)) {
        const role = T.roleOf(d.prop);
        if (!role || !d.value.includes('var(') || style.getPropertyValue(d.prop)) continue;
        const t = this.ctx.model.transformValue(d.value, role, ctx);
        if (t === d.value) continue;
        const imp = d.important ? ' !important' : '';
        out += `${d.prop}:${t}${imp};`;
        // Our shorthand resets its longhands; re-assert the ones the author set after it.
        if (T.VAR_SHORTHANDS.includes(d.prop)) {
          for (let i = 0; i < style.length; i++) {
            const lh = style[i];
            if (!lh.startsWith(d.prop + '-')) continue;
            const v = style.getPropertyValue(lh);
            if (v) out += `${lh}:${v}${style.getPropertyPriority(lh) === 'important' ? ' !important' : ''};`;
          }
        }
      }
      return out;
    }

    walk(rules, ctx) {
      let out = '';
      for (const rule of rules) {
        try {
          out += this.rule(rule, ctx);
        } catch (_) {
          /* skip a rule we can't read */
        }
      }
      return out;
    }

    rule(rule, ctx) {
      const model = this.ctx.model;
      if (rule instanceof CSSStyleRule) {
        this.noteColorScheme(rule);
        const key = ctx.source ? normSelector(rule.selectorText) : null;
        ctx.selector = rule.selectorText;
        const decls = this.decls(rule.style, ctx);
        if (key) ctx.seen.set(key, (ctx.seen.get(key) || 0) + 1);
        const nested = rule.cssRules && rule.cssRules.length ? this.walk(rule.cssRules, ctx) : '';
        if (!decls && !nested) return '';
        ctx.rules = (ctx.rules || 0) + 1;
        const sel = this.useExclusion ? T.addExclusion(rule.selectorText) : rule.selectorText;
        return `${sel}{${decls}${nested}}`;
      }
      if (has('CSSNestedDeclarations') && rule instanceof root.CSSNestedDeclarations) {
        return this.decls(rule.style, ctx);
      }
      if (rule instanceof CSSMediaRule) {
        const m = rule.media.mediaText;
        if (PRINT_ONLY.test(m)) return '';
        // The author's own dark design: mirror it unchanged, so it keeps
        // beating the (transformed) base rules it was written to override.
        const prev = ctx.authorDark;
        if (isAuthorDark(m)) ctx.authorDark = true;
        let inner;
        try {
          inner = this.walk(rule.cssRules, ctx);
        } finally {
          ctx.authorDark = prev;
        }
        return inner ? `@media ${darkMedia(m)}{${inner}}` : '';
      }
      if (rule instanceof CSSSupportsRule) {
        const inner = this.walk(rule.cssRules, ctx);
        return inner ? `@supports ${rule.conditionText}{${inner}}` : '';
      }
      if (has('CSSLayerBlockRule') && rule instanceof root.CSSLayerBlockRule) {
        const inner = this.walk(rule.cssRules, ctx);
        if (!inner) return '';
        // Named layers are global, so re-entering them keeps the page's layer
        // order. Anonymous layers cannot be re-entered; treat as unlayered.
        return rule.name ? `@layer ${rule.name}{${inner}}` : inner;
      }
      if (rule instanceof CSSImportRule) return this.importRule(rule, ctx);
      if (rule instanceof CSSKeyframesRule) return this.keyframes(rule, ctx);
      if (rule instanceof CSSNamespaceRule) {
        ctx.ns.push(rule.cssText);
        return '';
      }
      if (has('CSSPropertyRule') && rule instanceof root.CSSPropertyRule) {
        if (!rule.initialValue) return '';
        const variants = model.defineVariants(rule.name, rule.initialValue, ctx);
        if (!variants) return '';
        return `:where(:root){${variants.map(([n, v]) => `${n}:${v};`).join('')}}`;
      }
      if (rule instanceof CSSFontFaceRule || rule instanceof CSSPageRule) return '';
      // Generic grouping rules: @container, @scope, @starting-style, future ones.
      if (rule.cssRules && rule.cssRules.length) {
        const inner = this.walk(rule.cssRules, ctx);
        if (!inner) return '';
        const prelude = preludeOf(rule);
        return prelude ? `${prelude}{${inner}}` : '';
      }
      return '';
    }

    decls(style, ctx) {
      const model = this.ctx.model;
      let out = '';
      let pending = false;
      const clip = /text/.test(style.getPropertyValue('background-clip') + style.getPropertyValue('-webkit-background-clip'));
      for (let i = 0; i < style.length; i++) {
        const prop = style[i];
        if (prop.charCodeAt(0) === 45 && prop.charCodeAt(1) === 45) {
          const raw = style.getPropertyValue(prop);
          let variants = model.defineVariants(prop, raw, ctx);
          if (variants && ctx.authorDark) variants = model.passThroughVariants(prop, raw, ctx);
          if (variants) {
            if (!this.colorVars.has(prop)) {
              this.colorVars.add(prop);
              this.varsGrew = true;
            }
          } else if (this.colorVars.has(prop)) {
            variants = model.passThroughVariants(prop, raw, ctx);
          }
          if (variants) {
            const imp = style.getPropertyPriority(prop) === 'important' ? ' !important' : '';
            for (const [n, v] of variants) out += `${n}:${v}${imp};`;
            this.ctx.stats.vars = (this.ctx.stats.vars || 0) + 1;
          }
          continue;
        }
        let role = T.roleOf(prop);
        const imp = style.getPropertyPriority(prop) === 'important' ? ' !important' : '';
        if (!role) {
          if (prop === 'mix-blend-mode' && T.BLEND_OFF.has(style.getPropertyValue(prop).trim())) {
            out += `mix-blend-mode:normal${imp};`;
          }
          continue;
        }
        const value = style.getPropertyValue(prop);
        if (!value) {
          pending = true;
          continue;
        }
        if (clip && prop === 'background-image') role = 'fg';
        // Mirror every color declaration, changed or not: our sheet comes after
        // the page's, so skipping an unchanged later rule (`.btn--ghost {
        // background: transparent }`) would let our override of an earlier
        // rule win the cascade.
        out += `${prop}:${ctx.authorDark ? value : model.transformValue(value, role, ctx)}${imp};`;
      }
      if (pending) {
        let recovered = false;
        for (const sh of T.VAR_SHORTHANDS) {
          const v = style.getPropertyValue(sh);
          if (!v || !v.includes('var(')) continue;
          recovered = true;
          out += `${sh}:${ctx.authorDark ? v : model.transformValue(v, T.roleOf(sh), ctx)}${style.getPropertyPriority(sh) === 'important' ? ' !important' : ''};`;
        }
        if (!recovered) out += this.fromSource(style, ctx);
      }
      return out;
    }

    keyframes(rule, ctx) {
      const model = this.ctx.model;
      let changed = false;
      let body = '';
      for (const kf of rule.cssRules) {
        let decls = '';
        const st = kf.style;
        for (let i = 0; i < st.length; i++) {
          const prop = st[i];
          const v = st.getPropertyValue(prop);
          const role = T.roleOf(prop);
          const t = role ? model.transformValue(v, role, ctx) : v;
          if (t !== v) changed = true;
          decls += `${prop}:${t};`;
        }
        body += `${kf.keyText}{${decls}}`;
      }
      return changed ? `@keyframes ${rule.name}{${body}}` : '';
    }

    importRule(rule, ctx) {
      const href = this.abs(rule.href, ctx.base);
      let rules = null;
      try {
        rules = rule.styleSheet && rule.styleSheet.cssRules;
      } catch (_) {
        const f = this.fetchSheet(href);
        if (f.status === 'done') rules = f.sheet.cssRules;
        else if (f.status === 'pending' && ctx.state) ctx.state.pending = true;
      }
      if (!rules) return '';
      const media = rule.media && rule.media.mediaText;
      let inner = this.walk(rules, { ...ctx, base: href, authorDark: ctx.authorDark || isAuthorDark(media) });
      if (!inner) return '';
      if (media) {
        if (PRINT_ONLY.test(media)) return '';
        inner = `@media ${darkMedia(media)}{${inner}}`;
      }
      if (rule.supportsText) inner = `@supports ${rule.supportsText}{${inner}}`;
      if (rule.layerName) inner = `@layer ${rule.layerName}{${inner}}`;
      return inner;
    }

    // -------------------------------------------------------------------------
    // Cross-origin sheets: cssRules throws, so the service worker fetches the
    // text (it has host permissions) and we parse it into a private sheet.
    fetchSheet(href) {
      let f = this.fetched.get(href);
      if (f) return f;
      f = { status: 'pending', sheet: null };
      this.fetched.set(href, f);
      this.fetchCss(href, 0)
        .then((text) => {
          if (text == null) {
            f.status = 'failed';
            return;
          }
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(text);
          f.sheet = sheet;
          f.text = text;
          f.status = 'done';
          this.rebuildHref(href);
        })
        .catch(() => {
          f.status = 'failed';
        });
      return f;
    }

    async fetchCss(href, depth) {
      let text = await this.ctx.fetchText(href);
      if (text == null) return null;
      text = text.replace(/^﻿?\s*@charset[^;]*;/i, '');
      if (depth > 2) return text.replace(/@import[^;]*;/gi, '');
      const IMPORT = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s]+)\1\s*\)?([^;]*);/gi;
      const imports = [];
      let m;
      while ((m = IMPORT.exec(text))) imports.push({ stmt: m[0], url: this.abs(m[2], href), tail: m[3].trim() });
      for (const imp of imports) {
        let inner = (await this.fetchCss(imp.url, depth + 1)) || '';
        let tail = imp.tail;
        const layer = /^layer(?:\(([^)]*)\))?/i.exec(tail);
        if (layer) tail = tail.slice(layer[0].length).trim();
        const supports = /^supports\((.*)\)/i.exec(tail);
        if (supports) tail = tail.slice(supports[0].length).trim();
        if (tail) inner = `@media ${tail}{${inner}}`;
        if (supports) inner = `@supports (${supports[1]}){${inner}}`;
        if (layer && layer[1]) inner = `@layer ${layer[1]}{${inner}}`;
        text = text.replace(imp.stmt, () => inner);
      }
      return text;
    }

    rebuildHref() {
      // Cross-origin entries change signature on their own ('xo|done');
      // same-origin sheets that were waiting on a cross-origin @import must
      // be invalidated explicitly.
      for (const e of this.entries.values()) if (e.pendingImport) e.sig = null;
      this.scheduleSync();
    }

    // -------------------------------------------------------------------------
    // Author-managed subtrees: an element with color-scheme containing "dark"
    // or "only" keeps its authored colors (Safari: "Apply color-scheme: light
    // dark to the relevant element and add your own dark styles").
    noteColorScheme(rule) {
      const v = rule.style.getPropertyValue('color-scheme');
      if (!v || !/dark|only/i.test(v)) return;
      const sel = rule.selectorText.trim();
      if (/^(:root|html|body|:host)$/i.test(sel)) return;
      if (this.exclusions.has(sel)) return;
      this.exclusions.add(sel);
      this.ctx.onExclusions([...this.exclusions]);
    }

    enableExclusion() {
      if (this.useExclusion) return;
      this.useExclusion = true;
      for (const e of this.entries.values()) e.sig = null;
      this.scheduleSync();
    }
  }

  ADM.SheetEngine = SheetEngine;
  ADM.SheetEngine.indexSource = indexSource;
  ADM.SheetEngine.normSelector = normSelector;
})(globalThis);
