/*
 * Adaptive Dark Mode — images.
 *
 * WebKit: most images are left unchanged; SVG images are inspected and
 * adjusted when needed; bitmaps are classified by pixel histogram and simple
 * black-and-white logos are inverted. Only the part of a bitmap that is
 * actually drawn is classified (WebKit commit b5d0911616); we approximate that
 * by only considering logo/icon-sized boxes. <canvas> and <video> are never
 * touched.
 */
(function (root) {
  'use strict';
  const ADM = root.ADM;
  const D = ADM.dom;
  const IC = ADM.imageclass;

  const MAX_AREA = 160000; // CSS px²: beyond this an image is content, not a logo
  const MAX_SIDE = 640;

  class ImageEngine {
    constructor(ctx) {
      this.ctx = ctx; // { model, settings, stats, classifyRemote(url), fetchText(url) }
      this.verdicts = new Map(); // url -> Promise<verdict>
      this.seen = new WeakMap(); // element -> url handled
      this.meta = new WeakMap(); // element -> verdict (for text-over-image decisions)
    }

    verdictFor(el) {
      return this.meta.get(el) || null;
    }

    async processImg(img) {
      if (!this.ctx.settings.images) return;
      const src = img.currentSrc || img.src;
      if (!src || this.seen.get(img) === src) return;
      if (img.closest('[data-adm-x]')) return;
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        if (!img.complete) img.addEventListener('load', () => this.processImg(img), { once: true });
        return;
      }
      this.seen.set(img, src);
      // Tracking pixels and spacers: nothing to adapt, not worth a fetch.
      if (rect.width < 12 || rect.height < 12) return;
      // Photos and large artwork are content: leave them (Safari does too).
      // Their brightness is only looked up if text turns out to sit on them.
      if (rect.width * rect.height > MAX_AREA || Math.max(rect.width, rect.height) > MAX_SIDE) {
        return D.setFlag(img, 'data-adm-img', null);
      }
      if (getComputedStyle(img).filter !== 'none' && !img.hasAttribute('data-adm-img')) return;
      const v = await this.classify(src, img);
      if (!v || !img.isConnected) return;
      this.meta.set(img, v);
      if (v.kind === 'invert') {
        D.setFlag(img, 'data-adm-img', 'inv');
        this.ctx.stats.images = (this.ctx.stats.images || 0) + 1;
      } else {
        D.setFlag(img, 'data-adm-img', null);
      }
    }

    /** Small icon element painted with a background image, or a big tiled texture. */
    async processBackground(el, cs) {
      if (!this.ctx.settings.images) return;
      const m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(cs.backgroundImage);
      if (!m) return;
      const url = m[1];
      if (this.seen.get(el) === url) return;
      this.seen.set(el, url);
      const rect = el.getBoundingClientRect();
      const iconLike = rect.width <= 96 && rect.height <= 96 && el.childElementCount === 0 && !el.textContent.trim();
      const large = rect.width * rect.height > 100000;
      const tiled = !/no-repeat/.test(cs.backgroundRepeat);
      if (!iconLike && !(large && tiled)) return;
      const v = await this.classify(url, null);
      if (!v || !el.isConnected) return;
      this.meta.set(el, v);
      if (iconLike && v.kind === 'invert') {
        D.setFlag(el, 'data-adm-img', 'inv');
        this.ctx.stats.images = (this.ctx.stats.images || 0) + 1;
      } else if (large && tiled && v.kind === 'texture') {
        // A light paper/noise texture would stay bright on a dark page.
        D.setFlag(el, 'data-adm-img', 'untex');
        const bg = ADM.color.parse(cs.backgroundColor);
        if (!bg || bg.a === 0) D.setAdjust(el, 'data-adm-bg', '--adm-bg', this.ctx.model.transformColorString(v.meanColor, 'bg'));
      }
    }

    /** Classify an <img> on demand (used for text-over-image decisions). */
    ensureMeta(img) {
      if (this.meta.has(img)) return Promise.resolve(this.meta.get(img));
      const src = img.currentSrc || img.src;
      if (!src) return Promise.resolve(null);
      return this.classify(src, img).then((v) => {
        if (v) this.meta.set(img, v);
        return v;
      });
    }

    classify(url, img) {
      let p = this.verdicts.get(url);
      if (p) return p;
      p = this.classifyUncached(url, img).catch(() => null);
      this.verdicts.set(url, p);
      return p;
    }

    async classifyUncached(url, img) {
      const isSvg = /^data:image\/svg/i.test(url) || /\.svg(?:[?#]|$)/i.test(url);
      if (isSvg && url.startsWith('data:')) return this.classifySvgText(decodeData(url));
      // Same-origin / CORS-clean / data: bitmaps can be read locally.
      if (img && img.complete && img.naturalWidth && sameOriginOrData(url, img)) {
        const local = this.classifyLocal(img);
        if (local) return local;
      }
      const remote = await this.ctx.classifyRemote(url);
      if (!remote) return null;
      if (remote.svg) return this.classifySvgText(remote.svg);
      return remote;
    }

    classifyLocal(img) {
      try {
        const w = Math.min(64, img.naturalWidth);
        const h = Math.max(1, Math.round((w * img.naturalHeight) / img.naturalWidth));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = Math.min(64, h);
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
        return IC.classifyPixels(data, canvas.width, canvas.height);
      } catch (_) {
        return null; // tainted canvas
      }
    }

    classifySvgText(text) {
      if (!text) return null;
      try {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        if (doc.querySelector('parsererror')) return null;
        const v = IC.classifySvgDocument(doc);
        return { ...v, meanY: v.kind === 'invert' ? 0.05 : null };
      } catch (_) {
        return null;
      }
    }

    /** Element quirks: force the color-preserving inversion on (Safari's forceFilterSelector). */
    applyForceInvert(rootNode, selector) {
      if (!selector) return;
      let list;
      try {
        list = rootNode.querySelectorAll(selector);
      } catch (_) {
        return;
      }
      for (const el of list) D.setFlag(el, 'data-adm-img', 'inv');
    }
  }

  function sameOriginOrData(url, img) {
    if (/^(data|blob):/i.test(url)) return true;
    try {
      return new URL(url, document.baseURI).origin === location.origin || img.crossOrigin != null;
    } catch (_) {
      return false;
    }
  }

  function decodeData(url) {
    const comma = url.indexOf(',');
    const meta = url.slice(0, comma);
    const body = url.slice(comma + 1);
    try {
      return /;base64/i.test(meta) ? atob(body) : decodeURIComponent(body);
    } catch (_) {
      return null;
    }
  }

  ADM.ImageEngine = ImageEngine;
})(globalThis);
