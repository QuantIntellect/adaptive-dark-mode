/*
 * Adaptive Dark Mode — service worker.
 *
 *  - single writer for settings and the per-site verdict cache,
 *  - fetches cross-origin style sheets (content scripts can't read their rules),
 *  - decodes cross-origin bitmaps off the page (no canvas tainting) and runs
 *    the histogram classifier on an OffscreenCanvas,
 *  - toolbar badge + keyboard shortcut.
 */
/* global importScripts */
importScripts('../shared/color.js', '../shared/settings.js', '../shared/imageclass.js');

const { settings: S, imageclass: IC } = self.ADM;

// -----------------------------------------------------------------------------
// Settings (serialized writes)
// -----------------------------------------------------------------------------
let writeChain = Promise.resolve();
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return S.withDefaults(settings);
}
function updateSettings(mutate) {
  writeChain = writeChain.then(async () => {
    const s = await getSettings();
    mutate(s);
    await chrome.storage.local.set({ settings: s });
    return s;
  }).catch(() => {});
  return writeChain;
}

let verdictChain = Promise.resolve();
function saveVerdict(key, v, scheme) {
  verdictChain = verdictChain.then(async () => {
    const { verdicts = {} } = await chrome.storage.local.get('verdicts');
    if (verdicts[key] && verdicts[key].v === v && verdicts[key].s === scheme) return;
    // s: the system appearance the verdict was recorded under (sites that
    // follow it are light in light mode and dark in dark mode).
    verdicts[key] = { v, s: scheme, t: Date.now() };
    const keys = Object.keys(verdicts);
    if (keys.length > 3000) {
      keys.sort((a, b) => verdicts[a].t - verdicts[b].t).slice(0, keys.length - 2500).forEach((k) => delete verdicts[k]);
    }
    await chrome.storage.local.set({ verdicts });
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await chrome.storage.local.set({ settings: s });
  await chrome.action.setBadgeBackgroundColor({ color: '#2c2c2e' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#30d158' });
});

// -----------------------------------------------------------------------------
// Fetch helpers (small LRU caches; the service worker may be restarted anytime)
// -----------------------------------------------------------------------------
function lru(max) {
  const map = new Map();
  return {
    get(k) {
      const v = map.get(k);
      if (v !== undefined) {
        map.delete(k);
        map.set(k, v);
      }
      return v;
    },
    set(k, v) {
      map.set(k, v);
      if (map.size > max) map.delete(map.keys().next().value);
    },
  };
}
const cssCache = lru(150);
const imageCache = lru(600);

function okUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

async function fetchCss(url) {
  if (!okUrl(url)) return null;
  let p = cssCache.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length') || 0);
      if (len > 8e6) return null;
      return res.text();
    })().catch(() => null);
    cssCache.set(url, p);
  }
  return p;
}

async function classifyImage(url) {
  if (!okUrl(url)) return null;
  let p = imageCache.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
      if (!res.ok) return null;
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const len = Number(res.headers.get('content-length') || 0);
      if (len > 12e6) return null;
      if (type.includes('svg') || /\.svg(?:[?#]|$)/i.test(url)) {
        const text = await res.text();
        return text.length > 1e6 ? null : { svg: text };
      }
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 64 / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(bitmap, 0, 0, w, h);
      const data = g.getImageData(0, 0, w, h).data;
      const result = IC.classifyPixels(data, w, h);
      result.width = bitmap.width;
      result.height = bitmap.height;
      bitmap.close();
      return result;
    })().catch(() => null);
    imageCache.set(url, p);
  }
  return p;
}

// -----------------------------------------------------------------------------
// Badge
// -----------------------------------------------------------------------------
const BADGE = {
  active: { text: 'ON', color: '#2c2c2e' },
  offer: { text: 'TRY', color: '#0a84ff' },
};
const tabState = new Map(); // tabId -> top-frame state
chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));

function setBadge(tabId, state) {
  const b = BADGE[state];
  chrome.action.setBadgeText({ tabId, text: b ? b.text : '' }).catch(() => {});
  if (b) chrome.action.setBadgeBackgroundColor({ tabId, color: b.color }).catch(() => {});
  if (b && chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ tabId, color: state === 'active' ? '#30d158' : '#ffffff' }).catch(() => {});
  }
}

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'adm:fetch':
      fetchCss(msg.url).then((text) => sendResponse(text == null ? { ok: false } : { ok: true, text }));
      return true;
    case 'adm:classify':
      classifyImage(msg.url).then((result) => sendResponse(result ? { ok: true, result } : { ok: false }));
      return true;
    case 'adm:frameInfo': {
      let topHost = null;
      try {
        topHost = new URL(sender.tab && sender.tab.url).hostname;
      } catch (_) {
        /* no tab url */
      }
      sendResponse({ topHost, topState: sender.tab ? tabState.get(sender.tab.id) : null });
      return;
    }
    case 'adm:state':
      if (sender.tab && sender.frameId === 0) {
        const prev = tabState.get(sender.tab.id);
        tabState.set(sender.tab.id, msg.state);
        setBadge(sender.tab.id, msg.state);
        // Subframes adapt only while the top frame does.
        if ((prev === 'active') !== (msg.state === 'active')) {
          chrome.tabs.sendMessage(sender.tab.id, { type: 'adm:topState', state: msg.state }).catch(() => {});
        }
      }
      return;
    case 'adm:verdict':
      if (typeof msg.key === 'string' && ['light', 'dark', 'declares'].includes(msg.v)) saveVerdict(msg.key, msg.v, msg.s === 'dark' ? 'dark' : 'light');
      return;
    case 'adm:setSite':
      updateSettings((s) => {
        if (msg.value === 'on' || msg.value === 'off') s.sites[msg.key] = msg.value;
        else delete s.sites[msg.key];
        delete s.dismissed[msg.key];
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'adm:setScope':
      updateSettings((s) => {
        if (msg.value === 'all' || msg.value === 'ask') s.scope = msg.value;
      }).then(() => sendResponse({ ok: true }));
      return true;
    case 'adm:dismiss':
      updateSettings((s) => {
        s.dismissed[msg.key] = Date.now();
      });
      return;
    default:
  }
});

// -----------------------------------------------------------------------------
// Keyboard shortcut: toggle the current site
// -----------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-site') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  let host;
  try {
    host = new URL(tab.url).hostname;
  } catch (_) {
    return;
  }
  const key = S.siteKey(host);
  updateSettings((s) => {
    const current = S.lookup(s.sites, host);
    const effectiveOn = current === 'on' || (current !== 'off' && s.scope === 'all');
    s.sites[key] = effectiveOn ? 'off' : 'on';
  });
});
