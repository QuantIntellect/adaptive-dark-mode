/*
 * Adaptive Dark Mode — image classification.
 *
 * WebKit: "Most [images] are left unchanged... For bitmap images, it analyzes
 * the pixel histograms and inverts simple black-and-white logos." The open
 * WebCore hooks show three outcomes (ImagePaintTimeTransformation):
 * Unchanged, SimpleInvert, ColorPreservingInvert. Here a single
 * color-preserving invert (`invert(1) hue-rotate(180deg)`) covers both,
 * because for gray pixels the two are identical.
 *
 * Also classifies SVG sources by the paint colors they declare, mirroring
 * "Adaptive Dark Mode inspects SVG images and transforms colors when needed".
 */
(function (root) {
  'use strict';
  const ADM = root.ADM || (root.ADM = {});
  const C = ADM.color;

  /**
   * @param {Uint8ClampedArray} data RGBA pixels
   * @returns {{kind:'keep'|'invert'|'texture', meanY:number, meanColor:string, transparentFrac:number, colors:number}}
   */
  function classifyPixels(data, width, height) {
    const total = width * height;
    let transparent = 0;
    let opaque = 0;
    let neutral = 0;
    let dark = 0;
    let darkNeutral = 0;
    let light = 0;
    let sumY = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 20) {
        transparent++;
        continue;
      }
      opaque++;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const Y = (0.2126 * C.toLinear(r / 255) + 0.7152 * C.toLinear(g / 255) + 0.0722 * C.toLinear(b / 255));
      sumY += Y;
      sr += r;
      sg += g;
      sb += b;
      const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      if (chroma < 0.12) neutral++;
      if (Y < 0.18) dark++;
      if (Y < 0.18 && chroma < 0.12) darkNeutral++;
      if (Y > 0.8) light++;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const result = {
      kind: 'keep',
      meanY: opaque ? sumY / opaque : 1,
      meanColor: opaque ? C.format({ r: sr / opaque / 255, g: sg / opaque / 255, b: sb / opaque / 255, a: 1 }) : '#ffffff',
      transparentFrac: total ? transparent / total : 1,
      colors: 0,
    };
    if (!opaque || opaque / total < 0.01) return result;
    let colors = 0;
    for (const count of buckets.values()) if (count >= opaque * 0.004) colors++;
    result.colors = colors;
    const neutralFrac = neutral / opaque;
    const darkFrac = dark / opaque;
    const lightFrac = light / opaque;

    if (result.transparentFrac >= 0.1) {
      // Glyph/logo on a transparent background: if it is mostly dark neutral
      // ink it would vanish on a dark page. A colored accent (a logo mark)
      // is fine: the color-preserving inversion keeps its hue.
      const inkFrac = darkNeutral / opaque;
      if ((neutralFrac >= 0.8 || inkFrac >= 0.55) && result.meanY < 0.35 && lightFrac < 0.15) result.kind = 'invert';
    } else if (result.transparentFrac < 0.02) {
      // "Simple black-and-white logo": few colors, gray, bimodal with a white
      // field that was baked into the image.
      // Edge antialiasing (and our downscale) adds intermediate grays, so the
      // test is "gray, mostly white, with real black ink" rather than strictly 2 colors.
      if (colors <= 24 && neutralFrac >= 0.92 && lightFrac >= 0.45 && darkFrac >= 0.03 && lightFrac + darkFrac >= 0.7) {
        result.kind = 'invert';
      } else if (neutralFrac >= 0.9 && result.meanY > 0.8 && colors <= 24) {
        result.kind = 'texture'; // light, flat, gray: e.g. a tiled paper texture
      }
    }
    return result;
  }

  /** Classify SVG markup (already parsed into a Document) by its paints. */
  function classifySvgDocument(doc) {
    const colors = [];
    let usesDefaultFill = false;
    const shapes = doc.querySelectorAll('path, circle, rect, ellipse, polygon, polyline, line, text, use');
    const collect = (value) => {
      if (!value) return;
      const v = value.trim().toLowerCase();
      if (!v || v === 'none' || v.startsWith('url(') || v === 'currentcolor' || v === 'inherit') return;
      const c = C.parse(v);
      if (c && c.a > 0) colors.push(c);
    };
    for (const el of shapes) {
      const fill = el.getAttribute('fill') || styleValue(el, 'fill');
      const stroke = el.getAttribute('stroke') || styleValue(el, 'stroke');
      if (!fill && !hasInheritedPaint(el, 'fill')) usesDefaultFill = true;
      collect(fill);
      collect(stroke);
    }
    for (const el of doc.querySelectorAll('[fill], [stroke], [stop-color]')) {
      collect(el.getAttribute('fill'));
      collect(el.getAttribute('stroke'));
      collect(el.getAttribute('stop-color'));
    }
    for (const style of doc.querySelectorAll('style')) {
      const text = style.textContent || '';
      const re = /(fill|stroke|stop-color)\s*:\s*([^;}]+)/gi;
      let m;
      while ((m = re.exec(text))) collect(m[2]);
    }
    if (usesDefaultFill) colors.push({ r: 0, g: 0, b: 0, a: 1 });
    return classifyPaints(colors);
  }

  function styleValue(el, prop) {
    const s = el.getAttribute('style');
    if (!s) return null;
    const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'i').exec(s);
    return m ? m[1] : null;
  }
  function hasInheritedPaint(el, prop) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.getAttribute(prop) || styleValue(p, prop)) return true;
    }
    return false;
  }

  /**
   * Decide from a set of paint colors whether an SVG should be inverted.
   * Invert only "dark monochrome" artwork: dark neutrals, no light neutrals
   * (which would mean the artwork carries its own light canvas), and at most
   * one accent color.
   */
  function classifyPaints(colors) {
    let darkNeutral = 0;
    let lightNeutral = 0;
    const vivid = new Set();
    for (const c of colors) {
      const { C: chroma } = C.toOklch(C.clampColor(c));
      const Y = C.luminance(c);
      if (chroma >= 0.08) vivid.add(C.format({ ...c, a: 1 }));
      else if (Y < 0.25) darkNeutral++;
      else if (Y > 0.6) lightNeutral++;
    }
    const kind = darkNeutral > 0 && lightNeutral === 0 && vivid.size <= 1 ? 'invert' : 'keep';
    return { kind, darkNeutral, lightNeutral, vivid: vivid.size };
  }

  ADM.imageclass = { classifyPixels, classifySvgDocument, classifyPaints };
})(typeof globalThis !== 'undefined' ? globalThis : self);
