/*
 * Adaptive Dark Mode — color primitives.
 *
 * Parsing for every CSS color syntax Chrome can hand us (hex, rgb/hsl/hwb,
 * lab/lch/oklab/oklch, color(), named colors), WCAG luminance/contrast, and
 * OKLCH helpers used by the transform model. Pure functions, no DOM access, so
 * the same file runs in content scripts, the service worker and Node tests.
 *
 * Internal color representation: { r, g, b, a } with sRGB channels in 0..1
 * (may be slightly out of gamut before clamping) and alpha in 0..1.
 */
(function (root) {
  'use strict';
  const ADM = root.ADM || (root.ADM = {});

  // ---------------------------------------------------------------------------
  // Named colors (CSS Color 4) and keywords we must never transform.
  // ---------------------------------------------------------------------------
  const NAMED = {
    aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff',
    beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff',
    blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00',
    chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
    cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9',
    darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f',
    darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f',
    darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1',
    darkviolet: '9400d3', deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969',
    dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff',
    gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080',
    green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4',
    indianred: 'cd5c5c', indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa',
    lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080',
    lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3',
    lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899',
    lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32',
    linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd',
    mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee',
    mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970',
    mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080',
    oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500',
    orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093',
    papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd',
    powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f',
    royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57',
    seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd',
    slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4',
    tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0',
    violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00',
    yellowgreen: '9acd32',
  };

  // System colors are "semantic": WebKit exempts them from Adaptive Dark Mode's
  // color filter and resolves them with the dark appearance instead (WebKit
  // commit 6f60a8837e). We do the same by setting `color-scheme: dark` on the
  // root and never rewriting these keywords.
  const SYSTEM = new Set([
    'canvas', 'canvastext', 'linktext', 'visitedtext', 'activetext', 'buttonface', 'buttontext',
    'buttonborder', 'field', 'fieldtext', 'highlight', 'highlighttext', 'selecteditem', 'selecteditemtext',
    'mark', 'marktext', 'graytext', 'accentcolor', 'accentcolortext', 'activeborder', 'activecaption',
    'appworkspace', 'background', 'buttonhighlight', 'buttonshadow', 'captiontext', 'inactiveborder',
    'inactivecaption', 'inactivecaptiontext', 'infobackground', 'infotext', 'menu', 'menutext', 'scrollbar',
    'threeddarkshadow', 'threedface', 'threedhighlight', 'threedlightshadow', 'threedshadow', 'window',
    'windowframe', 'windowtext',
  ]);

  const COLOR_FUNCS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color']);

  // ---------------------------------------------------------------------------
  // Small math helpers
  // ---------------------------------------------------------------------------
  const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
  const toLinear = (c) => {
    const a = Math.abs(c);
    return a <= 0.04045 ? c / 12.92 : Math.sign(c) * Math.pow((a + 0.055) / 1.055, 2.4);
  };
  const toGamma = (c) => {
    const a = Math.abs(c);
    return a <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * Math.pow(a, 1 / 2.4) - 0.055);
  };
  const mul3 = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];

  // Matrices (CSS Color 4 sample code).
  const XYZ65_TO_LSRGB = [
    3.2409699419045226, -1.537383177570094, -0.4986107602930034,
    -0.9692436362808796, 1.8759675015077202, 0.04155505740717559,
    0.05563007969699366, -0.20397695888897652, 1.0569715142428786,
  ];
  const LSRGB_TO_XYZ65 = [
    0.41239079926595934, 0.357584339383878, 0.1804807884018343,
    0.21263900587151027, 0.715168678767756, 0.07219231536073371,
    0.01933081871559182, 0.11919477979462598, 0.9505321522496607,
  ];
  const D50_TO_D65 = [
    0.955473421488075, -0.02309845494876471, 0.06325924320057072,
    -0.0283697093338637, 1.0099953980813041, 0.021041441191917323,
    0.012314014864481998, -0.020507649298898964, 1.330365926242124,
  ];
  const P3_TO_XYZ65 = [
    0.4865709486482162, 0.26566769316909306, 0.1982172852343625,
    0.2289745640697488, 0.6917385218365064, 0.079286914093745,
    0, 0.04511338185890264, 1.043944368900976,
  ];
  const REC2020_TO_XYZ65 = [
    0.6369580483012914, 0.14461690358620832, 0.1688809751641721,
    0.2627002120112671, 0.6779980715188708, 0.05930171646986196,
    0, 0.028072693049087428, 1.060985057710791,
  ];
  const A98_TO_XYZ65 = [
    0.5766690429101305, 0.1855582379065463, 0.1882286462349947,
    0.29734497525053605, 0.6273635662554661, 0.0752914584939978,
    0.02703136138641234, 0.07068885253582723, 0.9913375368376388,
  ];
  const D50 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

  function xyz65ToSrgb(xyz) {
    const lin = mul3(XYZ65_TO_LSRGB, xyz);
    return lin.map(toGamma);
  }

  function labToXyz50(L, a, b) {
    const k = 24389 / 27;
    const e = 216 / 24389;
    const f1 = (L + 16) / 116;
    const f0 = a / 500 + f1;
    const f2 = f1 - b / 200;
    const x = Math.pow(f0, 3) > e ? Math.pow(f0, 3) : (116 * f0 - 16) / k;
    const y = L > k * e ? Math.pow((L + 16) / 116, 3) : L / k;
    const z = Math.pow(f2, 3) > e ? Math.pow(f2, 3) : (116 * f2 - 16) / k;
    return [x * D50[0], y * D50[1], z * D50[2]];
  }

  // OKLab <-> linear sRGB (Björn Ottosson).
  function oklabToLinearSrgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }
  function linearSrgbToOklab(r, g, b) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  }
  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    let s = 0;
    if (d !== 0) {
      s = l === 0 || l === 1 ? 0 : (max - l) / Math.min(l, 1 - l);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------
  function parseHex(hex) {
    const h = hex.replace('#', '');
    if (!/^[0-9a-f]+$/i.test(h)) return null;
    let r, g, b, a = 255;
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
      if (h.length === 4) a = parseInt(h[3] + h[3], 16);
    } else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
      if (h.length === 8) a = parseInt(h.slice(6, 8), 16);
    } else {
      return null;
    }
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
  }

  // Split function arguments: handles both legacy comma syntax and modern
  // space syntax with an optional "/ alpha".
  function splitArgs(body) {
    let alpha = null;
    let main = body;
    const slash = body.indexOf('/');
    if (slash !== -1) {
      main = body.slice(0, slash);
      alpha = body.slice(slash + 1).trim();
    }
    const legacy = main.includes(',');
    let parts = legacy ? main.split(',') : main.trim().split(/\s+/);
    parts = parts.map((p) => p.trim()).filter((p) => p.length);
    // Only the legacy comma syntax carries alpha as a 4th argument
    // (rgba(0, 0, 0, .5)); in space syntax alpha always follows "/".
    if (alpha === null && legacy && parts.length === 4) alpha = parts.pop();
    return { parts, alpha };
  }

  function num(token, percentScale = 1) {
    if (token == null) return NaN;
    const t = token.trim().toLowerCase();
    if (t === 'none') return 0;
    if (t.endsWith('%')) return (parseFloat(t) / 100) * percentScale;
    return parseFloat(t);
  }
  function hue(token) {
    const t = token.trim().toLowerCase();
    if (t === 'none') return 0;
    const v = parseFloat(t);
    if (t.endsWith('turn')) return v * 360;
    if (t.endsWith('grad')) return v * 0.9;
    if (t.endsWith('rad')) return (v * 180) / Math.PI;
    return v;
  }
  function alphaOf(token) {
    if (token == null) return 1;
    const v = num(token, 1);
    return Number.isFinite(v) ? clamp(v) : 1;
  }

  function parseFunction(name, body) {
    const { parts, alpha } = splitArgs(body);
    const a = alphaOf(alpha);
    let rgb = null;
    switch (name) {
      case 'rgb':
      case 'rgba': {
        if (parts.length < 3) return null;
        rgb = parts.slice(0, 3).map((p) => num(p, 255) / 255);
        break;
      }
      case 'hsl':
      case 'hsla': {
        if (parts.length < 3) return null;
        const s = parts[1].endsWith('%') ? num(parts[1], 1) : parseFloat(parts[1]) / 100;
        const l = parts[2].endsWith('%') ? num(parts[2], 1) : parseFloat(parts[2]) / 100;
        rgb = hslToRgb(hue(parts[0]), clamp(s), clamp(l));
        break;
      }
      case 'hwb': {
        if (parts.length < 3) return null;
        let w = parts[1].endsWith('%') ? num(parts[1], 1) : parseFloat(parts[1]) / 100;
        let bl = parts[2].endsWith('%') ? num(parts[2], 1) : parseFloat(parts[2]) / 100;
        if (w + bl >= 1) {
          const gray = w / (w + bl);
          rgb = [gray, gray, gray];
        } else {
          const base = hslToRgb(hue(parts[0]), 1, 0.5);
          rgb = base.map((c) => c * (1 - w - bl) + w);
        }
        break;
      }
      case 'lab': {
        if (parts.length < 3) return null;
        const L = num(parts[0], 100);
        const A = num(parts[1], 125);
        const B = num(parts[2], 125);
        rgb = xyz65ToSrgb(mul3(D50_TO_D65, labToXyz50(L, A, B)));
        break;
      }
      case 'lch': {
        if (parts.length < 3) return null;
        const L = num(parts[0], 100);
        const C = num(parts[1], 150);
        const H = (hue(parts[2]) * Math.PI) / 180;
        rgb = xyz65ToSrgb(mul3(D50_TO_D65, labToXyz50(L, C * Math.cos(H), C * Math.sin(H))));
        break;
      }
      case 'oklab': {
        if (parts.length < 3) return null;
        const L = num(parts[0], 1);
        const A = num(parts[1], 0.4);
        const B = num(parts[2], 0.4);
        rgb = oklabToLinearSrgb(L, A, B).map(toGamma);
        break;
      }
      case 'oklch': {
        if (parts.length < 3) return null;
        const L = num(parts[0], 1);
        const C = num(parts[1], 0.4);
        const H = (hue(parts[2]) * Math.PI) / 180;
        rgb = oklabToLinearSrgb(L, C * Math.cos(H), C * Math.sin(H)).map(toGamma);
        break;
      }
      case 'color': {
        if (parts.length < 4) return null;
        const space = parts[0].toLowerCase();
        const v = parts.slice(1, 4).map((p) => num(p, 1));
        switch (space) {
          case 'srgb': rgb = v; break;
          case 'srgb-linear': rgb = v.map(toGamma); break;
          case 'display-p3': rgb = xyz65ToSrgb(mul3(P3_TO_XYZ65, v.map(toLinear))); break;
          case 'rec2020': {
            const lin = v.map((c) => {
              const x = Math.abs(c);
              return x < 0.08124285829863151 ? c / 4.5 : Math.sign(c) * Math.pow((x + 0.09929682680944) / 1.09929682680944, 1 / 0.45);
            });
            rgb = xyz65ToSrgb(mul3(REC2020_TO_XYZ65, lin));
            break;
          }
          case 'a98-rgb': rgb = xyz65ToSrgb(mul3(A98_TO_XYZ65, v.map((c) => Math.sign(c) * Math.pow(Math.abs(c), 563 / 256)))); break;
          case 'xyz':
          case 'xyz-d65': rgb = xyz65ToSrgb(v); break;
          case 'xyz-d50': rgb = xyz65ToSrgb(mul3(D50_TO_D65, v)); break;
          default: return null;
        }
        break;
      }
      default:
        return null;
    }
    if (!rgb || rgb.some((c) => !Number.isFinite(c))) return null;
    return { r: rgb[0], g: rgb[1], b: rgb[2], a };
  }

  const parseCache = new Map();
  /**
   * Parse a single CSS color. Returns null for anything that is not a
   * concrete color (var(), currentcolor, system colors, gradients...).
   */
  function parse(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    if (!s) return null;
    const cached = parseCache.get(s);
    if (cached !== undefined) return cached && { ...cached };
    let out = null;
    if (s[0] === '#') out = parseHex(s);
    else if (s === 'transparent') out = { r: 0, g: 0, b: 0, a: 0 };
    else if (NAMED[s]) out = parseHex(NAMED[s]);
    else {
      const m = /^([a-z]+)\(([^()]*)\)$/.exec(s);
      if (m && COLOR_FUNCS.has(m[1]) && !m[2].includes('var') && !m[2].includes('from ')) {
        out = parseFunction(m[1], m[2]);
      }
    }
    if (parseCache.size > 20000) parseCache.clear();
    parseCache.set(s, out);
    return out && { ...out };
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------
  const hex2 = (v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0');
  function format(c) {
    if (!c) return '';
    const a = Math.round(clamp(c.a) * 1000) / 1000;
    if (a >= 1) return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
    const r = Math.round(clamp(c.r) * 255);
    const g = Math.round(clamp(c.g) * 255);
    const b = Math.round(clamp(c.b) * 255);
    return `rgb(${r} ${g} ${b} / ${a})`;
  }
  function clampColor(c) {
    return { r: clamp(c.r), g: clamp(c.g), b: clamp(c.b), a: clamp(c.a) };
  }

  // ---------------------------------------------------------------------------
  // Luminance, contrast, compositing (WCAG 2.x definitions)
  // ---------------------------------------------------------------------------
  function luminance(c) {
    return 0.2126 * toLinear(clamp(c.r)) + 0.7152 * toLinear(clamp(c.g)) + 0.0722 * toLinear(clamp(c.b));
  }
  function contrastY(ya, yb) {
    return (Math.max(ya, yb) + 0.05) / (Math.min(ya, yb) + 0.05);
  }
  function contrast(a, b) {
    return contrastY(luminance(a), luminance(b));
  }
  /** Source-over composite of `top` onto an opaque-or-not `bottom`. */
  function composite(top, bottom) {
    const a = top.a + bottom.a * (1 - top.a);
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
  }

  // ---------------------------------------------------------------------------
  // OKLCH helpers
  // ---------------------------------------------------------------------------
  function toOklch(c) {
    const [L, A, B] = linearSrgbToOklab(toLinear(c.r), toLinear(c.g), toLinear(c.b));
    const C = Math.sqrt(A * A + B * B);
    let H = (Math.atan2(B, A) * 180) / Math.PI;
    if (H < 0) H += 360;
    return { L, C, H };
  }
  function inGamut(lin, eps = 1e-4) {
    return lin.every((v) => v >= -eps && v <= 1 + eps);
  }
  /** OKLCH -> sRGB, reducing chroma until the color fits in sRGB. */
  function fromOklch(L, C, H, a = 1) {
    const h = (H * Math.PI) / 180;
    let lin = oklabToLinearSrgb(L, C * Math.cos(h), C * Math.sin(h));
    if (!inGamut(lin)) {
      let lo = 0;
      let hi = C;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        const t = oklabToLinearSrgb(L, mid * Math.cos(h), mid * Math.sin(h));
        if (inGamut(t)) lo = mid;
        else hi = mid;
      }
      lin = oklabToLinearSrgb(L, lo * Math.cos(h), lo * Math.sin(h));
    }
    return { r: clamp(toGamma(lin[0])), g: clamp(toGamma(lin[1])), b: clamp(toGamma(lin[2])), a };
  }

  /**
   * Return a color with the same OKLCH hue and (gamut-permitting) chroma as
   * `c` but with WCAG relative luminance `targetY`.
   */
  const lumCache = new Map();
  function withLuminance(c, targetY) {
    targetY = clamp(targetY);
    const key = format({ ...c, a: 1 }) + '|' + targetY.toFixed(4);
    const hit = lumCache.get(key);
    if (hit) return { ...hit, a: c.a };
    const { C, H } = toOklch(clampColor(c));
    let out;
    if (C < 0.004) {
      const v = clamp(toGamma(targetY));
      out = { r: v, g: v, b: v, a: 1 };
    } else {
      let lo = 0;
      let hi = 1;
      out = fromOklch(0.5, C, H);
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        const cand = fromOklch(mid, C, H);
        if (luminance(cand) < targetY) lo = mid;
        else hi = mid;
        out = cand;
      }
      out = fromOklch((lo + hi) / 2, C, H);
    }
    if (lumCache.size > 20000) lumCache.clear();
    lumCache.set(key, out);
    return { ...out, a: c.a };
  }

  ADM.color = {
    NAMED,
    SYSTEM,
    COLOR_FUNCS,
    parse,
    format,
    clamp,
    clampColor,
    luminance,
    contrast,
    contrastY,
    composite,
    toOklch,
    fromOklch,
    withLuminance,
    rgbToHsl,
    hslToRgb,
    toLinear,
    toGamma,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
