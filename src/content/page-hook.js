/*
 * Adaptive Dark Mode — main-world hook (runs in the page's JS world).
 *
 * CSS-in-JS libraries (styled-components, emotion, JSS...) add rules with
 * CSSStyleSheet.insertRule, which MutationObserver cannot see. Shadow roots
 * attached after insertion are equally invisible. This hook only *signals*
 * the isolated extension world; it never reads or sends page data.
 *
 * Wrappers are Proxies, so Function.prototype.toString still reports native
 * code. That makes the hook harder to notice, though a page can still detect it.
 */
(function () {
  'use strict';
  if (window.__admPageHook) return;
  Object.defineProperty(window, '__admPageHook', { value: true });

  let pending = false;
  const signal = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      document.dispatchEvent(new Event('__adm_cssom'));
    });
  };

  const wrap = (proto, name, after) => {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.value !== 'function') return;
    const native = desc.value;
    const proxy = new Proxy(native, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args);
        try {
          after(thisArg, result);
        } catch (_) {
          /* never break the page */
        }
        return result;
      },
    });
    Object.defineProperty(proto, name, { ...desc, value: proxy });
  };

  for (const name of ['insertRule', 'deleteRule', 'addRule', 'removeRule', 'replaceSync']) {
    wrap(CSSStyleSheet.prototype, name, signal);
  }
  wrap(CSSStyleSheet.prototype, 'replace', (_, promise) => {
    if (promise && typeof promise.then === 'function') promise.then(signal, () => {});
  });
  if (typeof CSSGroupingRule !== 'undefined') {
    wrap(CSSGroupingRule.prototype, 'insertRule', signal);
    wrap(CSSGroupingRule.prototype, 'deleteRule', signal);
  }

  // adoptedStyleSheets setters on Document and ShadowRoot.
  for (const proto of [Document.prototype, ShadowRoot.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
    if (!desc || !desc.set) continue;
    const nativeSet = desc.set;
    Object.defineProperty(proto, 'adoptedStyleSheets', {
      ...desc,
      set: new Proxy(nativeSet, {
        apply(target, thisArg, args) {
          const r = Reflect.apply(target, thisArg, args);
          signal();
          return r;
        },
      }),
    });
  }

  wrap(Element.prototype, 'attachShadow', (host) => {
    host.dispatchEvent(new Event('__adm_shadow'));
  });
})();
