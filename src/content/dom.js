/*
 * Adaptive Dark Mode — small DOM helpers shared by the content engines.
 *
 * Every per-element adjustment is expressed as a data-adm-* attribute plus a
 * custom property in the element's style. The page's own inline declarations
 * stay untouched (so element.style.color still reads what the author wrote),
 * and a single base sheet maps the attributes to !important declarations.
 */
(function (root) {
  'use strict';
  const ADM = root.ADM;

  // :is() takes the specificity of its most specific argument, so this gives
  // attribute rules (2,0,0) specificity without needing those ids to exist.
  const BOOST = '#adm-boost#adm-boost';
  const sel = (attr) => `:is([${attr}],${BOOST})`;

  const written = new WeakMap(); // element -> style attribute after our last write
  const touched = new Set(); // elements we changed, for clean shutdown

  function mark(el) {
    written.set(el, el.getAttribute('style'));
    touched.add(el);
  }
  function isOwnStyleWrite(el) {
    return written.has(el) && written.get(el) === el.getAttribute('style');
  }

  /** Set (value !== null) or clear one adjustment: attribute + custom prop. */
  function setAdjust(el, attr, prop, value) {
    if (value === null || value === undefined) {
      if (!el.hasAttribute(attr) && !el.style.getPropertyValue(prop)) return;
      el.removeAttribute(attr);
      el.style.removeProperty(prop);
    } else {
      if (el.getAttribute(attr) === '' && el.style.getPropertyValue(prop) === value) return;
      el.style.setProperty(prop, value);
      el.setAttribute(attr, '');
    }
    if (!el.getAttribute('style')) el.removeAttribute('style');
    mark(el);
  }

  function setFlag(el, attr, value) {
    if (value === null || value === undefined) {
      if (el.hasAttribute(attr)) el.removeAttribute(attr);
    } else if (el.getAttribute(attr) !== value) {
      el.setAttribute(attr, value);
    }
    touched.add(el);
  }

  const ATTRS = [
    'data-adm-fg', 'data-adm-bg', 'data-adm-hl', 'data-adm-img', 'data-adm-canvas', 'data-adm-svgf',
    'data-adm-svgs', 'data-adm-i', 'data-adm-x', 'data-adm-base', 'data-adm-fill', 'data-adm-stroke', 'data-adm-ctl',
  ];

  /** Remove everything we ever wrote on an element. */
  function clean(el) {
    for (const a of ATTRS) if (el.hasAttribute(a)) el.removeAttribute(a);
    const style = el.style;
    if (style) {
      const ours = [];
      for (let i = 0; i < style.length; i++) if (style[i].startsWith('--adm-')) ours.push(style[i]);
      for (const p of ours) style.removeProperty(p);
      if (el.getAttribute('style') === '') el.removeAttribute('style');
    }
    written.delete(el);
  }

  function cleanAll() {
    for (const el of touched) clean(el);
    touched.clear();
  }

  /** Iterate an element tree including open/closed shadow roots. */
  function shadowRootOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return root.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(el) : null;
    } catch (_) {
      return null;
    }
  }

  ADM.dom = { BOOST, sel, mark, isOwnStyleWrite, setAdjust, setFlag, clean, cleanAll, shadowRootOf, touched };
})(globalThis);
