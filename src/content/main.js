/*
 * Adaptive Dark Mode — content controller.
 *
 * Lifecycle (same gates, in the same order, as Safari):
 *   1. system appearance is dark (or mode "always"),
 *   2. the user allowed this site (Try / popup) or all bright sites,
 *      and no force-disable quirk applies,
 *   3. the page does not declare color-scheme "dark" or "only",
 *   4. the rendered page samples as predominantly light.
 * Then the engines run: style sheets -> inline styles -> layout pass ->
 * images. A per-site verdict cache lets known-bright sites start at
 * document_start, before first paint.
 */
(function () {
  'use strict';
  const ADM = globalThis.ADM;
  if (!ADM || ADM.__started) return;
  ADM.__started = true;
  if (!/html/i.test(document.contentType || '')) return;

  const S = ADM.settings;
  const C = ADM.color;
  const D = ADM.dom;
  const isTop = window.top === window;
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  let settings = S.withDefaults(null);
  let topHost = location.hostname;
  let topActive = isTop; // subframes adapt only while the top frame does
  let decidedCanvasY = null; // authored root canvas luminance at decision time
  let engine = null;
  let state = 'starting';
  let reason = 'starting';
  let sample = null;
  let offered = false;
  let forcedThisTab = false;
  let retryTimers = [];
  let reevalTimer = 0;
  let periodic = 0;
  const stats = {};
  const timing = {};

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError;
          resolve(r);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }
  const fetchText = (url) => send({ type: 'adm:fetch', url }).then((r) => (r && r.ok ? r.text : null));
  const classifyRemote = (url) => send({ type: 'adm:classify', url }).then((r) => (r && r.ok ? r.result : null));

  function report() {
    if (!isTop) return;
    send({ type: 'adm:state', state, reason });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function boot() {
    let stored = {};
    try {
      stored = await chrome.storage.local.get(['settings', 'verdicts']);
    } catch (_) {
      return; // extension context gone
    }
    settings = S.withDefaults(stored.settings);
    if (!isTop) {
      const info = await send({ type: 'adm:frameInfo' });
      if (info && info.topHost) topHost = info.topHost;
      topActive = !!(info && info.topState === 'active');
    }
    const pol = S.policy(settings, topHost, darkMQ.matches);
    const cached = stored.verdicts && stored.verdicts[S.siteKey(location.hostname)];
    if (pol.allowed && pol.wanted && topActive && cached && cached.v === 'light') {
      timing.early = true;
      start();
    }
    whenReady(() => {
      evaluate('ready');
      watchRoot();
    });
    window.addEventListener('load', () => {
      if (engine) engine.sheets.scheduleSync();
      if (!sample || sample.verdict === 'empty') evaluate('load');
    });
  }

  function whenReady(fn) {
    const go = () => requestAnimationFrame(() => setTimeout(fn, 0));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  }

  // ---------------------------------------------------------------------------
  // Decision
  // ---------------------------------------------------------------------------
  function evaluate(trigger) {
    const t0 = performance.now();
    const pol = S.policy(settings, topHost, darkMQ.matches);
    if (!pol.allowed) return deactivate(pol.reason);
    if (!topActive) return deactivate('top-inactive');

    // Sample the whole viewport only to make the initial decision, or after a
    // real navigation near the top of the page. Later triggers (class toggles,
    // settings) must not re-sample whatever section happens to be in view:
    // a dark band mid-page would switch the mode off.
    const decided = sample && sample.verdict !== 'empty';
    const nearTop = window.scrollY < innerHeight * 0.5;
    const fullSample = !decided || (trigger === 'navigate' && nearTop);

    // Look at the page as authored: our sheets off for the duration of the
    // measurement (synchronous, so nothing is painted in between).
    const wasActive = !!engine;
    if (wasActive) engine.sheets.setDisabled(true);
    let scheme = null;
    let canvasY = null;
    try {
      scheme = ADM.detect.authorScheme();
      if (!scheme) {
        canvasY = C.luminance(ADM.detect.canvasColor());
        if (fullSample) sample = ADM.detect.sampleAppearance();
      }
    } finally {
      if (wasActive) engine.sheets.setDisabled(false);
    }
    timing.detectMs = Math.round((performance.now() - t0) * 10) / 10;
    timing.trigger = trigger;

    if (scheme) {
      saveVerdict('declares');
      return deactivate(scheme === 'only' ? 'declares-light-only' : 'declares-dark');
    }
    if (fullSample) {
      if (sample.verdict === 'empty') {
        scheduleRetries();
        return;
      }
      decidedCanvasY = canvasY;
      if (nearTop) saveVerdict(sample.verdict);
    } else if (decidedCanvasY !== null && Math.abs(canvasY - decidedCanvasY) > 0.3) {
      // The site switched its own theme (e.g. <html class="dark">): follow
      // the authored page canvas, without trusting a scrolled viewport.
      sample = { ...sample, verdict: canvasY < 0.2 ? 'dark' : 'light', canvasY };
      decidedCanvasY = canvasY;
    }
    if (sample.verdict === 'dark') return deactivate('already-dark');

    if (pol.wanted || forcedThisTab) {
      activate();
      return;
    }
    deactivate('ask');
    state = 'offer';
    report();
    if (isTop && pol.offer && !offered) offer();
  }

  function scheduleRetries() {
    if (retryTimers.length) return;
    retryTimers = [600, 1500, 3500].map((ms) => setTimeout(() => {
      if (!sample || sample.verdict === 'empty') evaluate('retry');
    }, ms));
  }

  function scheduleReevaluate(ms = 400, trigger = 'change') {
    clearTimeout(reevalTimer);
    reevalTimer = setTimeout(() => evaluate(trigger), ms);
  }

  let lastVerdictSaved = null;
  function saveVerdict(v) {
    if (lastVerdictSaved === v) return;
    lastVerdictSaved = v;
    send({ type: 'adm:verdict', key: S.siteKey(location.hostname), v });
  }

  function activate(opts = {}) {
    if (engine) {
      state = 'active';
      reason = 'enabled';
      engine.updateBase();
      report();
      return;
    }
    const run = () => start();
    if (opts.transition && document.startViewTransition && !reducedMotion.matches) {
      try {
        document.startViewTransition(run);
        return;
      } catch (_) {
        /* fall through */
      }
    }
    run();
  }

  function deactivate(why) {
    reason = why;
    state = 'inactive';
    if (engine) stop();
    report();
  }

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------
  function start() {
    const t0 = performance.now();
    const model = ADM.transform.createModel({ depth: settings.depth, textContrast: settings.textContrast });
    const quirks = S.quirksFor(settings, location.hostname);
    const ctx = {
      model,
      settings,
      stats,
      fetchText,
      classifyRemote,
      onExclusions: (sels) => setExclusions(sels),
      onSheetsChanged: () => engine && engine.layout.refreshVisible(),
    };
    for (const k of Object.keys(stats)) delete stats[k];
    const images = new ADM.ImageEngine(ctx);
    ctx.images = images;
    const sheets = new ADM.SheetEngine(ctx);
    const inline = new ADM.InlineEngine(ctx);
    const layout = new ADM.LayoutEngine(ctx);
    const base = ADM.SheetEngine.makeSheet();
    engine = { ctx, model, images, sheets, inline, layout, base, quirks, observers: new Map(), exclusionSels: [], authorExclusions: [] };
    engine.updateBase = updateBase;
    updateBase();
    sheets.setBaseSheet(base);
    if (quirks.preserve) setExclusions([]);
    addRoot(document);
    clearInterval(periodic);
    periodic = setInterval(tick, 2500);
    state = 'active';
    reason = 'enabled';
    timing.startMs = Math.round((performance.now() - t0) * 10) / 10;
    report();
  }

  function stop() {
    clearInterval(periodic);
    const e = engine;
    engine = null;
    for (const mo of e.observers.values()) mo.disconnect();
    e.layout.stop();
    e.inline.restoreAll();
    e.sheets.stop();
    D.cleanAll();
  }

  function rootNeedsBackground() {
    const html = document.documentElement;
    const body = document.body;
    const ours = engine && engine.htmlBg ? engine.model.anchorCss : null;
    const transparent = (el) => {
      if (!el) return true;
      const cs = getComputedStyle(el);
      const c = ADM.color.parse(cs.backgroundColor);
      // Our own html rule must not count as an authored background (or the
      // rule would switch itself off on the next check).
      if (c && el === html && ours && ADM.color.format(c) === ours) return cs.backgroundImage === 'none';
      return (!c || c.a === 0) && cs.backgroundImage === 'none';
    };
    return transparent(html) && transparent(body);
  }

  function updateBase() {
    if (!engine) return;
    const m = engine.model;
    const transparentRoot = rootNeedsBackground();
    let css = '';
    if (isTop) {
      css += ':root{color-scheme:dark!important}';
      engine.htmlBg = transparentRoot;
      if (engine.htmlBg) css += `html{background-color:${m.anchorCss}!important}`;
      // Embedded frames keep the page's original scheme. Otherwise a
      // transparent light iframe (consent dialog, widget) whose scheme no
      // longer matches its element gets an opaque white canvas (CSS Color
      // Adjust) and covers the page.
      css += ':where(iframe,frame,embed,object){color-scheme:normal}';
    } else if (!transparentRoot) {
      // An opaque subframe can switch to dark controls; a transparent one
      // must stay transparent and keep matching its (normal-scheme) element.
      css += ':root{color-scheme:dark!important}';
    }
    css += ADM.InlineEngine.baseRules() + ADM.LayoutEngine.baseRules();
    css += ':where([data-adm-x="q"]){color-scheme:light}';
    const text = `@media screen{${css}}`;
    if (engine.baseText !== text) {
      engine.baseText = text;
      engine.base.replaceSync(text);
    }
  }

  function tick() {
    if (!engine || document.hidden) return;
    engine.sheets.syncAll();
    updateBase();
  }

  // ---------------------------------------------------------------------------
  // Roots (document + shadow roots)
  // ---------------------------------------------------------------------------
  const ROOT_ATTRS = ['class', 'style', 'data-theme', 'data-color-mode', 'data-bs-theme', 'data-mode', 'theme', 'dark'];

  function addRoot(r) {
    if (!engine || engine.observers.has(r)) return;
    const mo = new MutationObserver((muts) => onMutations(muts));
    mo.observe(r, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'bgcolor', 'color', 'text', 'media', 'disabled', 'rel', 'data-theme', 'data-color-mode', 'data-bs-theme', 'data-mode', 'theme', 'dark', 'content'],
    });
    engine.observers.set(r, mo);
    engine.sheets.addRoot(r);
    const node = r === document ? document.documentElement : r;
    if (!node) return;
    engine.inline.processTree(node);
    engine.layout.observeTree(node);
    markExclusions(node);
    engine.images.applyForceInvert(node, engine.quirks.forceInvert);
    scanShadows(node);
  }

  function scanShadows(node) {
    const visit = (el) => {
      if (el.hasAttribute('data-adm-x')) return;
      const sr = el.shadowRoot || (el.localName.includes('-') ? D.shadowRootOf(el) : null);
      if (sr) addRoot(sr);
    };
    if (node.nodeType === 1) visit(node);
    if (node.querySelectorAll) for (const el of node.querySelectorAll('*')) visit(el);
  }

  function onMutations(muts) {
    if (!engine) return;
    let sheetDirty = false;
    let rootChanged = false;
    const added = new Set();
    const restyled = new Set();
    const html = document.documentElement;
    for (const m of muts) {
      const target = m.target;
      if (m.type === 'childList') {
        if (target.nodeName === 'STYLE') sheetDirty = true;
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') sheetDirty = true;
            else if (n.nodeName === 'META' && /color-scheme/i.test(n.getAttribute('name') || '')) rootChanged = true;
            if (n.nodeName === 'BODY') rootChanged = true;
            if (!n.hasAttribute('data-adm-x')) added.add(n);
          } else if (n.nodeType === 3 && target.nodeType === 1 && target.nodeName !== 'STYLE') {
            added.add(target);
          }
        }
        for (const n of m.removedNodes) if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') sheetDirty = true;
      } else if (m.type === 'characterData') {
        if (target.parentNode && target.parentNode.nodeName === 'STYLE') sheetDirty = true;
      } else if (m.type === 'attributes') {
        const name = m.attributeName;
        if (name === 'media' || name === 'disabled' || name === 'rel') {
          sheetDirty = true;
          continue;
        }
        if (name === 'content') {
          if (target.nodeName === 'META') rootChanged = true;
          continue;
        }
        if (name === 'style' && D.isOwnStyleWrite(target)) continue;
        if (target === html || target === document.body) {
          if (ROOT_ATTRS.includes(name)) rootChanged = true;
        }
        restyled.add(target);
      }
    }
    if (sheetDirty) engine.sheets.scheduleSync();
    for (const n of added) {
      engine.inline.processTree(n);
      engine.layout.observeTree(n);
      markExclusions(n);
      if (engine.quirks.forceInvert) engine.images.applyForceInvert(n, engine.quirks.forceInvert);
      scanShadows(n);
    }
    let budget = 150;
    for (const el of restyled) {
      if (!el.isConnected) continue;
      engine.inline.process(el);
      // A class/style change can change this element's own color: drop our
      // fix so the new authored color is visible, and re-check right away
      // (MutationObserver callbacks run before paint, so nothing flashes).
      if (el.hasAttribute('data-adm-fg')) {
        delete el.dataset.admBase;
        D.setAdjust(el, 'data-adm-fg', '--adm-fg', null);
      }
      if (budget-- > 0) {
        try {
          engine.layout.process(el);
        } catch (_) {
          /* ignore */
        }
      }
      // Descendants keep their fixes (re-evaluated from their stored base
      // color); only small subtrees are re-queued. Root-level class toggles
      // (sticky headers, scroll state) would otherwise re-check the page.
      if (el === html || el === document.body) continue;
      const n = el.getElementsByTagName('*').length;
      if (n && n < 400) engine.layout.observeTree(el);
    }
    if (rootChanged) {
      updateBase();
      scheduleReevaluate();
    }
  }

  /**
   * Theme switches live on <html>/<body> (class, data-theme...) or in a
   * color-scheme <meta>. This watcher outlives the engine, so a site that
   * switches back to its light theme is picked up again after we turned off.
   */
  function watchRoot() {
    const html = document.documentElement;
    const mo = new MutationObserver((muts) => {
      let relevant = false;
      for (const m of muts) {
        if (m.type === 'attributes') relevant = true;
        else for (const n of m.addedNodes) if (n.nodeName === 'BODY' || n.nodeName === 'META') relevant = true;
      }
      if (document.body && !mo.bodyWatched) {
        mo.observe(document.body, { attributes: true, attributeFilter: ROOT_ATTRS });
        mo.bodyWatched = true;
      }
      if (relevant && !engine) scheduleReevaluate();
    });
    mo.observe(html, { attributes: true, attributeFilter: ROOT_ATTRS, childList: true });
    if (document.head) mo.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] });
    if (document.body) {
      mo.observe(document.body, { attributes: true, attributeFilter: ROOT_ATTRS });
      mo.bodyWatched = true;
    }
  }

  // Author-managed subtrees and "preserve" quirks.
  function setExclusions(authorSels) {
    if (!engine) return;
    engine.authorExclusions = authorSels;
    for (const r of engine.observers.keys()) markExclusions(r === document ? document.documentElement : r);
  }

  function markExclusions(node) {
    if (!engine || !node || !node.querySelectorAll) return;
    const groups = [
      [engine.authorExclusions.join(','), ''],
      [engine.quirks.preserve, 'q'],
    ];
    let marked = false;
    for (const [sel, value] of groups) {
      if (!sel) continue;
      let list = [];
      try {
        list = [...node.querySelectorAll(sel)];
        if (node.nodeType === 1 && node.matches(sel)) list.push(node);
      } catch (_) {
        continue;
      }
      for (const el of list) {
        if (el.getAttribute('data-adm-x') === value) continue;
        el.setAttribute('data-adm-x', value);
        D.touched.add(el);
        for (const d of el.querySelectorAll('[data-adm-i],[data-adm-fg],[data-adm-bg],[data-adm-hl],[data-adm-img],[data-adm-svgf],[data-adm-svgs],[data-adm-canvas]')) {
          engine.inline.restore(d);
        }
        marked = true;
      }
    }
    if (marked) engine.sheets.enableExclusion();
  }

  // ---------------------------------------------------------------------------
  // Offer ("Try")
  // ---------------------------------------------------------------------------
  function offer() {
    offered = true;
    const key = S.siteKey(location.hostname);
    ADM.prompt.offer({
      host: key,
      onTry: () => {
        forcedThisTab = true;
        send({ type: 'adm:setSite', key, value: 'on' });
        activate({ transition: true });
        ADM.prompt.applied({
          host: key,
          onAll: () => send({ type: 'adm:setScope', value: 'all' }),
          onUndo: () => {
            forcedThisTab = false;
            send({ type: 'adm:setSite', key, value: null });
            deactivate('ask');
          },
        });
      },
      onDismiss: () => send({ type: 'adm:dismiss', key }),
    });
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  document.addEventListener('__adm_cssom', () => engine && engine.sheets.scheduleSync());
  document.addEventListener('__adm_shadow', (e) => {
    const host = e.target;
    queueMicrotask(() => {
      if (!engine || host.hasAttribute('data-adm-x')) return;
      const sr = D.shadowRootOf(host);
      if (sr) addRoot(sr);
    });
  }, true);
  document.addEventListener('load', (e) => {
    if (engine && e.target && e.target.nodeName === 'LINK') engine.sheets.scheduleSync();
  }, true);

  let hoverAt = 0;
  document.addEventListener('mouseover', (e) => {
    if (!engine) return;
    const now = performance.now();
    if (now - hoverAt < 80) return;
    hoverAt = now;
    const t = e.composedPath()[0];
    if (!t || t.nodeType !== 1) return;
    const lay = engine.layout;
    lay.queue.add(t);
    if (t.parentElement) lay.queue.add(t.parentElement);
    let n = 0;
    for (const d of t.querySelectorAll('*')) {
      if (n++ > 40) break;
      if (ADM.LayoutEngine.hasOwnText(d)) lay.queue.add(d);
    }
    lay.schedule();
  }, { capture: true, passive: true });

  darkMQ.addEventListener('change', () => evaluate('system-appearance'));
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigatesuccess', () => scheduleReevaluate(600, 'navigate'));
  } else {
    window.addEventListener('popstate', () => scheduleReevaluate(600, 'navigate'));
  }
  window.addEventListener('beforeprint', () => engine && engine.sheets.setDisabled(true));
  window.addEventListener('afterprint', () => engine && engine.sheets.setDisabled(false));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const prev = settings;
    settings = S.withDefaults(changes.settings.newValue);
    const rebuild = engine && (prev.depth !== settings.depth || prev.textContrast !== settings.textContrast || prev.images !== settings.images || prev.hairlines !== settings.hairlines || prev.canvasIslands !== settings.canvasIslands || JSON.stringify(S.quirksFor(prev, location.hostname)) !== JSON.stringify(S.quirksFor(settings, location.hostname)));
    if (rebuild) stop();
    evaluate('settings');
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'adm:getStatus') {
      if (!isTop) return;
      sendResponse({
        state,
        reason,
        host: location.hostname,
        siteKey: S.siteKey(location.hostname),
        sample,
        stats: { ...stats },
        timing: {
          ...timing,
          sheetBuildMs: engine ? Math.round(engine.sheets.lastBuildMs * 10) / 10 : null,
          sheetTotalMs: engine ? Math.round(engine.sheets.totalMs) : null,
          sheetSyncs: engine ? engine.sheets.syncCount : null,
        },
        model: engine ? { depth: engine.model.depth, anchor: engine.model.anchorCss, pivotY: Math.round(engine.model.pivotY * 1000) / 1000 } : null,
      });
      return;
    }
    if (msg.type === 'adm:tryNow') {
      forcedThisTab = true;
      ADM.prompt.hide();
      activate({ transition: true });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'adm:topState') {
      if (isTop) return;
      const next = msg.state === 'active';
      if (next !== topActive) {
        topActive = next;
        evaluate('top');
      }
      return;
    }
    if (msg.type === 'adm:reevaluate') {
      evaluate('popup');
      sendResponse({ ok: true });
    }
  });

  boot();
})();
