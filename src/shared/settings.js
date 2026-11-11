/*
 * Adaptive Dark Mode — settings, per-site policy and built-in quirks.
 *
 * Mirrors Safari's control surface:
 *   - ADM only runs while the system appearance is dark (mode "system"),
 *   - the user opts in per site ("Try" prompt / popup) or for every bright
 *     site ("scope: all"),
 *   - the embedder can force-disable ADM for sites that misbehave
 *     (WKWebpagePreferences._forceDisableAXCustomColorMode, WebKit 324xxx),
 *   - element quirks can force the inversion filter on, or preserve authored
 *     colors, for specific selectors (Internals::setAXCustomColorModeElementQuirksForTesting).
 */
(function (root) {
  'use strict';
  const ADM = root.ADM || (root.ADM = {});

  const DEFAULTS = Object.freeze({
    mode: 'system', // 'system' (only when OS/browser is dark) | 'always' | 'off'
    scope: 'ask', // 'ask' (offer "Try" on bright pages) | 'all' (adapt every bright page)
    depth: 'standard', // 'soft' | 'standard' | 'deep' | 'oled'
    textContrast: 4.5, // WCAG target Safari aims for; 7 = AAA
    images: true, // invert simple black-and-white logos, adapt SVG icons
    hairlines: true, // keep surface separation visible
    canvasIslands: true, // keep a light backdrop behind transparent <canvas> charts
    prompt: true, // show the in-page "Try" offer
    sites: {}, // siteKey -> 'on' | 'off'
    dismissed: {}, // siteKey -> timestamp of "Not now"
    quirks: {}, // siteKey -> { disable?: true, forceInvert?: 'sel', preserve?: 'sel' }
  });

  // Conservative built-ins: apps that paint into <canvas> or already ship a
  // dark theme without declaring `color-scheme`. Users can override any of
  // these in the options page.
  const BUILTIN_QUIRKS = Object.freeze({
    'docs.google.com': { disable: true, note: 'Docs and Sheets render into canvas' },
    'figma.com': { disable: true, note: 'Canvas/WebGL app with its own theme' },
  });

  function siteKey(hostname) {
    return String(hostname || '').toLowerCase().replace(/^www\./, '');
  }

  // Find the most specific entry for a host in a domain-keyed map
  // ("a.b.example.com" matches "b.example.com" and "example.com").
  function lookup(map, host) {
    if (!map) return undefined;
    let h = siteKey(host);
    while (h) {
      if (Object.prototype.hasOwnProperty.call(map, h)) return map[h];
      const dot = h.indexOf('.');
      if (dot === -1) break;
      h = h.slice(dot + 1);
    }
    return undefined;
  }

  function quirksFor(settings, host) {
    const builtin = lookup(BUILTIN_QUIRKS, host) || {};
    const user = lookup(settings.quirks, host) || {};
    return {
      disable: user.disable !== undefined ? !!user.disable : !!builtin.disable,
      forceInvert: [builtin.forceInvert, user.forceInvert].filter(Boolean).join(', '),
      preserve: [builtin.preserve, user.preserve].filter(Boolean).join(', '),
    };
  }

  /**
   * Policy for a top-level host. Returns { allowed, wanted, offer, reason }:
   *   allowed — ADM may run here at all,
   *   wanted  — adapt automatically when the page is bright,
   *   offer   — show the "Try" prompt when the page is bright.
   */
  function policy(settings, host, systemDark) {
    const key = siteKey(host);
    const q = quirksFor(settings, host);
    const site = lookup(settings.sites, host);
    if (settings.mode === 'off') return { allowed: false, wanted: false, offer: false, reason: 'off' };
    if (settings.mode === 'system' && !systemDark) return { allowed: false, wanted: false, offer: false, reason: 'system-light' };
    if (site === 'off') return { allowed: false, wanted: false, offer: false, reason: 'site-off' };
    if (q.disable && site !== 'on') return { allowed: false, wanted: false, offer: false, reason: 'quirk-disabled' };
    if (site === 'on' || settings.scope === 'all') return { allowed: true, wanted: true, offer: false, reason: 'enabled' };
    const dismissedAt = settings.dismissed && settings.dismissed[key];
    const recentlyDismissed = dismissedAt && Date.now() - dismissedAt < 7 * 24 * 3600 * 1000;
    return { allowed: true, wanted: false, offer: !!settings.prompt && !recentlyDismissed, reason: 'ask' };
  }

  function withDefaults(stored) {
    const out = { ...DEFAULTS, ...(stored || {}) };
    for (const k of ['sites', 'dismissed', 'quirks']) out[k] = { ...(stored && stored[k]) };
    return out;
  }

  ADM.settings = { DEFAULTS, BUILTIN_QUIRKS, siteKey, lookup, quirksFor, policy, withDefaults };
})(typeof globalThis !== 'undefined' ? globalThis : self);
