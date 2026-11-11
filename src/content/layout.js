/*
 * Adaptive Dark Mode — the layout-aware ("backdrop") pass.
 *
 * WebKit runs two extra paint phases: AXCustomColorCollectBackgrounds records
 * every box that paints a background, then AXCustomColorComputeBackdrops finds,
 * for each text run and replaced element, what actually paints behind it
 * (WebKit commit f2468d106a). Text colors are then adjusted against that
 * backdrop. The rule-level transform can't know a backdrop, so this pass
 * does it on rendered elements, lazily, as they come into view:
 *
 *   - text over images / video / canvas keeps its authored color,
 *   - all other text is pushed to the contrast target against its real backdrop,
 *   - small dark controls whose surroundings were darkened flip to light
 *     (Safari turns a dark "Plan" pill light),
 *   - surfaces that lost their separation get a hairline (Safari:
 *     paintSurfaceHairlineIfNecessary),
 *   - inline SVG paints are adjusted against their backdrop,
 *   - transparent <canvas> elements keep a light backdrop so dark-on-
 *     transparent charts stay readable (Safari's Interop chart stays light).
 */
(function (root) {
  'use strict';
  const ADM = root.ADM;
  const C = ADM.color;
  const D = ADM.dom;
  const DET = ADM.detect;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'BR', 'WBR', 'OPTION']);
  const SVG_SHAPES = 'path,circle,rect,ellipse,polygon,polyline,line,text,tspan,use';

  class LayoutEngine {
    constructor(ctx) {
      this.ctx = ctx; // { model, settings, stats, images }
      this.queue = new Set();
      this.scheduled = false;
      this.observed = new WeakSet();
      this.surfaceSeen = new WeakMap(); // surface -> pass id
      this.pass = 0;
      this.running = true;
      this.visible = new Set();
      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            this.visible.add(e.target);
            this.queue.add(e.target);
          } else {
            this.visible.delete(e.target);
          }
        }
        this.schedule();
      }, { rootMargin: '300px 0px' });
      // Elements queued from the observer's margin are processed provisionally
      // (ancestor chain only: hit-testing needs on-screen coordinates) and
      // re-checked precisely once they actually scroll into view.
      this.offscreen = new Set();
      this.scrollQueued = false;
      this.onScroll = () => {
        if (this.scrollQueued || !this.offscreen.size) return;
        this.scrollQueued = true;
        requestAnimationFrame(() => {
          this.scrollQueued = false;
          const vh = innerHeight;
          const vw = innerWidth;
          for (const el of this.offscreen) {
            if (!el.isConnected) {
              this.offscreen.delete(el);
              continue;
            }
            const r = el.getBoundingClientRect();
            if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) {
              this.offscreen.delete(el);
              this.queue.add(el);
            }
          }
          this.schedule();
        });
      };
      addEventListener('scroll', this.onScroll, { capture: true, passive: true });
      addEventListener('resize', this.onScroll, { passive: true });
    }

    stop() {
      this.running = false;
      this.io.disconnect();
      this.queue.clear();
      this.visible.clear();
      this.offscreen.clear();
      removeEventListener('scroll', this.onScroll, { capture: true });
      removeEventListener('resize', this.onScroll);
    }

    /** Find candidates in a subtree and observe them. */
    observeTree(node) {
      if (!this.running || !node) return;
      const els = new Set();
      const base = node.nodeType === 1 || node.nodeType === 11 ? node : null;
      if (!base) return;
      const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
      let count = 0;
      while (walker.nextNode() && count < 50000) {
        const t = walker.currentNode;
        if (!t.nodeValue.trim()) continue;
        const p = t.parentElement;
        if (p && !SKIP_TAGS.has(p.tagName)) els.add(p);
        count++;
      }
      if (base.querySelectorAll) {
        for (const el of base.querySelectorAll('img,svg,canvas,i,span:empty,a:empty,button:empty,div:empty,[role="img"]')) {
          if (el instanceof SVGElement && el.ownerSVGElement) continue; // outermost <svg> only
          els.add(el);
        }
      }
      if (base.nodeType === 1 && !SKIP_TAGS.has(base.tagName)) els.add(base);
      for (const el of els) this.observe(el);
    }

    observe(el) {
      if (this.observed.has(el)) {
        this.queue.add(el);
        this.schedule();
        return;
      }
      this.observed.add(el);
      this.io.observe(el);
    }

    /** Re-check everything currently queued or visible (after sheet changes). */
    refreshVisible() {
      this.pass++;
      for (const el of this.visible) {
        if (el.isConnected) this.queue.add(el);
        else this.visible.delete(el);
      }
      this.schedule();
    }

    schedule() {
      if (this.scheduled || !this.running) return;
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }

    flush() {
      this.scheduled = false;
      if (!this.running) return;
      const start = performance.now();
      for (const el of this.queue) {
        this.queue.delete(el);
        try {
          this.process(el);
        } catch (_) {
          /* element vanished mid-way */
        }
        if (performance.now() - start > 10) break;
      }
      if (this.queue.size) this.schedule();
    }

    // -------------------------------------------------------------------------
    process(el) {
      if (!el.isConnected || el.closest('[data-adm-x]')) return;
      const tag = el.tagName;
      if (tag === 'IMG') return this.ctx.images.processImg(el);
      if (tag === 'CANVAS') return this.processCanvas(el);
      if (el instanceof SVGSVGElement) return this.processSvg(el);
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (cs.backgroundImage.includes('url(')) this.ctx.images.processBackground(el, cs);
      if (hasOwnText(el)) this.processText(el, cs);
    }

    probePoint(el) {
      const vw = innerWidth;
      const vh = innerHeight;
      for (const r of el.getClientRects()) {
        const x0 = Math.max(r.left, 0);
        const x1 = Math.min(r.right, vw);
        const y0 = Math.max(r.top, 0);
        const y1 = Math.min(r.bottom, vh);
        if (x1 - x0 >= 2 && y1 - y0 >= 2) return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
      }
      return null;
    }

    /**
     * What paints behind `el` at a point: walk the hit-test stack from `el`
     * downward (el's own background counts). Falls back to the ancestor chain
     * when `el` is not hit-testable (pointer-events: none) or off screen
     * (pt === null).
     */
    backdrop(el, pt, includeSelf = true) {
      const scope = el.getRootNode();
      const stack = pt ? (typeof scope.elementsFromPoint === 'function' ? scope : document).elementsFromPoint(pt.x, pt.y) : [];
      let i = stack.indexOf(el);
      let chain;
      if (i === -1) {
        chain = [];
        const up = (a) => a.parentElement || (a.getRootNode() instanceof ShadowRoot ? a.getRootNode().host : null);
        for (let a = includeSelf ? el : up(el); a; a = up(a)) chain.push(a);
      } else {
        chain = stack.slice(includeSelf ? i : i + 1);
      }
      let acc = { r: 0, g: 0, b: 0, a: 0 };
      let surface = null;
      for (let k = 0; k < chain.length; k++) {
        const node = chain[k];
        if (node !== el && DET.MEDIA_TAGS.has(node.tagName)) return { media: node };
        if (node instanceof SVGElement) continue;
        const cs = getComputedStyle(node);
        // A small, non-repeating icon on an opaque surface (a button's
        // glyph) doesn't make its text "text over an image".
        const ownColor = C.parse(cs.backgroundColor);
        const decorativeIcon = cs.backgroundImage.includes('url(') && ownColor && ownColor.a >= 0.99 &&
          !/cover/.test(cs.backgroundSize) && /no-repeat/.test(cs.backgroundRepeat);
        if (cs.backgroundImage !== 'none' && !decorativeIcon) {
          if (cs.backgroundImage.includes('url(')) {
            const v = this.ctx.images.verdictFor(node);
            if (!v) {
              // Unclassified background image: classify it (it may be a light
              // texture we remove), then look at this text again.
              this.ctx.images.processBackground(node, cs).then(() => {
                if (el.isConnected) {
                  this.queue.add(el);
                  this.schedule();
                }
              });
            }
            if (!v || v.kind !== 'texture') return { media: node };
          } else {
            const g = DET.gradientColor(cs.backgroundImage);
            if (g) acc = C.composite(acc, g);
          }
        }
        const bg = C.parse(cs.backgroundColor);
        if (bg && bg.a > 0) {
          if (!surface) surface = { el: node, color: bg, below: chain.slice(k + 1) };
          acc = C.composite(acc, bg);
        }
        if (acc.a >= 0.99) return { color: acc, surface };
      }
      return { color: C.composite(acc, DET.canvasColor(this.ctx.model.anchor)), surface };
    }

    processText(el, cs) {
      const model = this.ctx.model;
      const pt = this.probePoint(el);
      if (!pt) this.offscreen.add(el);
      const color = C.parse(cs.color);
      if (!color || color.a === 0) return;
      // Evaluate the color as the style sheets produce it, not our own fix.
      const prior = el.hasAttribute('data-adm-fg') ? C.parse(el.dataset.admBase || '') : null;
      const current = prior || color;
      const hit = this.backdrop(el, pt);

      if (hit.media) {
        // Text over an image keeps the colors the author chose for that image.
        const authored = C.parse(model.original(C.format(current))) || current;
        const v = this.ctx.images.verdictFor(hit.media);
        if (!v && hit.media.tagName === 'IMG') {
          // Only now is it worth knowing how bright the photo is.
          this.ctx.images.ensureMeta(hit.media).then((meta) => {
            if (meta && el.isConnected) {
              this.queue.add(el);
              this.schedule();
            }
          });
        }
        let pick = authored;
        if (v && typeof v.meanY === 'number') {
          const gray = { r: C.toGamma(v.meanY), g: C.toGamma(v.meanY), b: C.toGamma(v.meanY), a: 1 };
          if (C.contrast(current, gray) > C.contrast(authored, gray)) pick = current;
        }
        return this.setFg(el, current, C.format(pick) === C.format(current) ? null : pick);
      }

      const back = hit.color;
      const size = parseFloat(cs.fontSize) || 16;
      const bold = parseInt(cs.fontWeight, 10) >= 700;
      const target = size >= 24 || (bold && size >= 18.66) ? Math.min(3, model.textTarget) : model.textTarget;
      const fixed = model.ensureContrast(current, back, target);
      this.setFg(el, current, fixed === current ? null : fixed);
      if (pt && hit.surface) this.processSurface(hit.surface);
    }

    setFg(el, base, fixed) {
      if (fixed) {
        if (!el.hasAttribute('data-adm-fg')) this.ctx.stats.text = (this.ctx.stats.text || 0) + 1;
        el.dataset.admBase = C.format(base);
        D.setAdjust(el, 'data-adm-fg', '--adm-fg', C.format(fixed));
      } else if (el.hasAttribute('data-adm-fg')) {
        delete el.dataset.admBase;
        D.setAdjust(el, 'data-adm-fg', '--adm-fg', null);
      }
    }

    /** Small-control flip and surface hairlines (re-evaluated on every pass). */
    processSurface(surface) {
      const s = surface.el;
      if (s === document.documentElement || s === document.body) return;
      if (this.surfaceSeen.get(s) === this.pass) return;
      this.surfaceSeen.set(s, this.pass);
      const model = this.ctx.model;
      const flippedByUs = s.dataset.admCtl || null;
      const bg = flippedByUs ? C.parse(flippedByUs) : surface.color;
      if (!bg || bg.a < 0.99) return;
      // Backdrop below the surface (continue the same stack).
      let acc = { r: 0, g: 0, b: 0, a: 0 };
      for (const node of surface.below) {
        if (DET.MEDIA_TAGS.has(node.tagName)) return;
        if (node instanceof SVGElement) continue;
        const ncs = getComputedStyle(node);
        if (ncs.backgroundImage.includes('url(')) return;
        const c = C.parse(ncs.backgroundColor);
        if (c && c.a > 0) acc = C.composite(acc, c);
        if (acc.a >= 0.99) break;
      }
      const below = acc.a >= 0.99 ? acc : C.composite(acc, DET.canvasColor(model.anchor));
      const rect = s.getBoundingClientRect();
      const bgCss = C.format(bg);
      const belowCss = C.format(below);
      const transformed = model.reverse.has(bgCss);
      // Only surroundings *we* darkened count. An authored dark region (a
      // footer, a dark card, a code block) keeps its dark controls.
      const belowTransformed = model.reverse.has(belowCss) || belowCss === model.anchorCss;
      const sep = C.contrast(bg, below);
      const small = rect.height <= 64 && rect.width <= 420 && rect.width * rect.height <= 22000;
      const shouldFlip = small && !transformed && !model.isVivid(bg) && C.luminance(bg) < model.pivotY * 0.5 && sep < 1.6 && belowTransformed;

      if (shouldFlip !== !!flippedByUs) {
        if (shouldFlip) {
          s.dataset.admCtl = bgCss;
          D.setAdjust(s, 'data-adm-bg', '--adm-bg', C.format(model.flip(bg)));
          this.ctx.stats.controls = (this.ctx.stats.controls || 0) + 1;
        } else {
          delete s.dataset.admCtl;
          D.setAdjust(s, 'data-adm-bg', '--adm-bg', null);
        }
        // Its text must be re-evaluated against the new surface.
        for (const t of s.querySelectorAll('*')) if (hasOwnText(t)) this.queue.add(t);
        if (hasOwnText(s)) this.queue.add(s);
        this.schedule();
        return;
      }
      if (shouldFlip) return;

      // Hairline when the transform removed the visible separation.
      let wantHairline = false;
      if (this.ctx.settings.hairlines && transformed && rect.width >= 40 && rect.height >= 24 && sep < 1.1) {
        const scs = getComputedStyle(s);
        const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(scs[`border${side}Width`]) > 0 && scs[`border${side}Style`] !== 'none');
        const origBg = C.parse(model.original(bgCss));
        const origBelow = C.parse(model.original(belowCss)) || below;
        wantHairline = !hasBorder && scs.boxShadow === 'none' && !!origBg && C.contrast(origBg, origBelow) >= 1.04;
      }
      if (wantHairline !== s.hasAttribute('data-adm-hl')) {
        D.setFlag(s, 'data-adm-hl', wantHairline ? '' : null);
        if (wantHairline) this.ctx.stats.hairlines = (this.ctx.stats.hairlines || 0) + 1;
      }
    }

    /** Inline SVG: adjust neutral paints that lost contrast with the backdrop. */
    processSvg(svg) {
      if (!this.ctx.settings.images) return;
      const pt = this.probePoint(svg);
      if (!pt) return void this.offscreen.add(svg);
      const hit = this.backdrop(svg, pt, false);
      if (hit.media) return;
      const back = hit.color;
      const model = this.ctx.model;
      const shapes = svg.querySelectorAll(SVG_SHAPES);
      if (shapes.length > 800) return;
      const svgRect = svg.getBoundingClientRect();
      const svgArea = Math.max(1, svgRect.width * svgRect.height);
      const paints = [];
      let lightFillArea = 0;
      for (const sh of shapes) {
        const cs = getComputedStyle(sh);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        for (const [prop, attr, cprop] of [['fill', 'data-adm-svgf', '--adm-svgf'], ['stroke', 'data-adm-svgs', '--adm-svgs']]) {
          const base = sh.hasAttribute(attr) ? C.parse(sh.dataset[prop === 'fill' ? 'admFill' : 'admStroke'] || '') : null;
          const c = base || C.parse(cs[prop]);
          if (!c || c.a === 0) continue;
          paints.push({ sh, prop, attr, cprop, c });
          if (prop === 'fill' && !model.isVivid(c) && C.luminance(c) > 0.6) {
            const r = sh.getBoundingClientRect();
            lightFillArea += r.width * r.height;
          }
        }
      }
      // Artwork that carries its own light canvas (e.g. a white disc behind a
      // glyph) keeps its internal contrast: leave it alone.
      if (lightFillArea / svgArea > 0.25) return;
      // A dark tile covering most of the artwork (an app-icon style logo) that
      // vanishes on the darkened page: invert the whole composition, glyph
      // included, so its internal contrast survives (Safari does this to logos).
      let dominant = null;
      for (const p of paints) {
        if (p.prop !== 'fill' || model.isVivid(p.c)) continue;
        const r = p.sh.getBoundingClientRect();
        const area = r.width * r.height;
        if (area / svgArea > 0.5 && (!dominant || area > dominant.area)) dominant = { p, area };
      }
      const invertAll = dominant && C.contrast(dominant.p.c, back) < 1.6;
      let changed = 0;
      for (const p of paints) {
        let next = null;
        if (!model.isVivid(p.c) && (invertAll || C.contrast(p.c, back) < 3)) next = model.flip(p.c);
        const key = p.prop === 'fill' ? 'admFill' : 'admStroke';
        if (next) {
          p.sh.dataset[key] = C.format(p.c);
          D.setAdjust(p.sh, p.attr, p.cprop, C.format(next));
          changed++;
        } else if (p.sh.hasAttribute(p.attr)) {
          delete p.sh.dataset[key];
          D.setAdjust(p.sh, p.attr, p.cprop, null);
        }
      }
      if (changed) this.ctx.stats.svg = (this.ctx.stats.svg || 0) + 1;
    }

    /** Keep a light island behind transparent canvases (charts drawn dark-on-transparent). */
    processCanvas(cv) {
      if (!this.ctx.settings.canvasIslands) return;
      const rect = cv.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 40) return;
      const bg = C.parse(getComputedStyle(cv).backgroundColor);
      if (bg && bg.a > 0 && !cv.hasAttribute('data-adm-canvas')) return;
      const pt = this.probePoint(cv);
      if (!pt) return void this.offscreen.add(cv);
      const hit = this.backdrop(cv, pt, false);
      if (hit.media || !hit.color) return;
      const model = this.ctx.model;
      const backCss = C.format(hit.color);
      if (C.luminance(hit.color) > 0.3) return;
      if (!cv.hasAttribute('data-adm-canvas')) {
        // Only charts: an origin-clean canvas that is mostly transparent and
        // draws dark ink. WebGL heroes, games and photos are left alone.
        const ink = canvasInk(cv);
        if (!ink || !ink.chart) {
          if (ink && ink.empty && !cv.__admRetried) {
            cv.__admRetried = true;
            setTimeout(() => this.observe(cv), 1200); // drawn later (animated charts)
          }
          return;
        }
      }
      const original = C.parse(model.original(backCss));
      const island = original && C.luminance(original) > 0.5 ? original : { r: 1, g: 1, b: 1, a: 1 };
      D.setAdjust(cv, 'data-adm-canvas', '--adm-canvas', C.format(island));
      this.ctx.stats.canvas = (this.ctx.stats.canvas || 0) + 1;
    }
  }

  /**
   * Read a canvas without touching its context: draw it into our own small
   * canvas (getImageData throws if the source is tainted).
   */
  function canvasInk(cv) {
    try {
      const w = 64;
      const h = Math.max(1, Math.round((64 * cv.height) / Math.max(1, cv.width)));
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = Math.min(64, h);
      const g = tmp.getContext('2d', { willReadFrequently: true });
      g.drawImage(cv, 0, 0, tmp.width, tmp.height);
      const d = g.getImageData(0, 0, tmp.width, tmp.height).data;
      let opaque = 0;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 24) continue;
        opaque++;
        const Y = 0.2126 * C.toLinear(d[i] / 255) + 0.7152 * C.toLinear(d[i + 1] / 255) + 0.0722 * C.toLinear(d[i + 2] / 255);
        if (Y < 0.25) ink++;
      }
      const total = d.length / 4;
      if (opaque < total * 0.003) return { empty: true, chart: false };
      return { empty: false, chart: opaque / total < 0.6 && ink / opaque >= 0.2 };
    } catch (_) {
      return null; // tainted: not ours to judge
    }
  }

  function hasOwnText(el) {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    }
    return false;
  }

  /** Base-sheet rules for layout adjustments. */
  function baseRules() {
    const s = D.sel;
    return [
      `${s('data-adm-fg')}{color:var(--adm-fg)!important}`,
      `${s('data-adm-bg')}{background-color:var(--adm-bg)!important}`,
      `${s('data-adm-hl')}:not(:focus-visible){outline:1px solid rgb(255 255 255 / .1)!important;outline-offset:-1px!important}`,
      `:is([data-adm-img="inv"],${D.BOOST}){filter:invert(1) hue-rotate(180deg)!important}`,
      `:is([data-adm-img="untex"],${D.BOOST}){background-image:none!important}`,
      `${s('data-adm-canvas')}{background-color:var(--adm-canvas)!important}`,
      `${s('data-adm-svgf')}{fill:var(--adm-svgf)!important}`,
      `${s('data-adm-svgs')}{stroke:var(--adm-svgs)!important}`,
    ].join('');
  }

  ADM.LayoutEngine = LayoutEngine;
  ADM.LayoutEngine.baseRules = baseRules;
  ADM.LayoutEngine.hasOwnText = hasOwnText;
})(globalThis);
