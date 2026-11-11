/* Adaptive Dark Mode — toolbar popup. */
(function () {
  'use strict';
  const S = globalThis.ADM.settings;
  const $ = (id) => document.getElementById(id);

  const REASONS = {
    active: ['Adapted to dark', 'on'],
    offer: ['Bright page · not adapted', 'offer'],
    ask: ['Bright page · not adapted', 'offer'],
    starting: ['Checking page…', ''],
    'already-dark': ['Page is already dark', ''],
    'declares-dark': ['Site has its own dark mode', ''],
    'declares-light-only': ['Site asks to stay light (light only)', 'warn'],
    'system-light': ['System appearance is light', ''],
    off: ['Turned off', ''],
    'site-off': ['Off for this site', ''],
    'quirk-disabled': ['Disabled here by a built-in quirk', 'warn'],
  };

  let tab = null;
  let settings = S.withDefaults(null);
  let status = null;

  const hostOf = () => {
    try {
      return new URL(tab.url).hostname;
    } catch (_) {
      return '';
    }
  };

  async function save(mutate) {
    const { settings: raw } = await chrome.storage.local.get('settings');
    const next = S.withDefaults(raw);
    mutate(next);
    await chrome.storage.local.set({ settings: next });
    settings = next;
    render();
    setTimeout(refreshStatus, 350);
  }

  async function refreshStatus() {
    status = null;
    if (tab && tab.id != null) {
      try {
        status = await chrome.tabs.sendMessage(tab.id, { type: 'adm:getStatus' }, { frameId: 0 });
      } catch (_) {
        status = null;
      }
    }
    render();
  }

  function render() {
    const host = hostOf();
    const key = S.siteKey(host);
    $('host').textContent = key || 'This page';
    const site = S.lookup(settings.sites, host);
    const quirk = S.quirksFor(settings, host);
    const effectiveOn = site === 'on' || (site !== 'off' && settings.scope === 'all' && !quirk.disable);
    $('siteToggle').checked = effectiveOn;
    $('siteToggle').disabled = !status;

    let text;
    let tone = '';
    if (!status) {
      text = /^https?:|^file:/.test(tab && tab.url) ? 'Reload the page to start' : 'Not available on this page';
    } else {
      const key2 = status.state === 'active' ? 'active' : status.state === 'offer' ? 'offer' : status.reason;
      [text, tone] = REASONS[key2] || [status.reason, ''];
    }
    $('status').textContent = text;
    $('dot').className = 'dot' + (tone ? ' ' + tone : '');

    const canTry = status && (status.state === 'offer' || (status.state === 'inactive' && status.reason === 'ask'));
    $('tryBtn').hidden = !canTry;

    const st = status && status.state === 'active' ? status.stats || {} : null;
    $('stats').hidden = !st;
    if (st) {
      const parts = [
        `${st.rules || 0} rules`,
        `${st.text || 0} text fixes`,
        `${st.images || 0} logos`,
        `${st.svg || 0} SVG`,
      ];
      if (st.controls) parts.push(`${st.controls} controls`);
      const t = status.timing || {};
      $('stats').textContent = parts.join(' · ') + (t.startMs != null ? ` · start ${t.startMs} ms` : '');
    }

    $('scopeAll').checked = settings.scope === 'all';
    for (const [id, value] of [['mode', settings.mode], ['depth', settings.depth], ['contrast', String(settings.textContrast)]]) {
      for (const b of $(id).querySelectorAll('button')) {
        const on = b.dataset.v === value;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        b.setAttribute('role', 'radio');
      }
    }
    for (const id of ['images', 'hairlines', 'canvasIslands', 'prompt']) $(id).checked = !!settings[id];
  }

  function bind() {
    $('siteToggle').addEventListener('change', (e) => {
      const key = S.siteKey(hostOf());
      if (!key) return;
      const on = e.target.checked;
      save((s) => {
        s.sites[key] = on ? 'on' : 'off';
        delete s.dismissed[key];
      });
    });
    $('tryBtn').addEventListener('click', async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'adm:tryNow' }, { frameId: 0 });
      } catch (_) {
        /* page not scriptable */
      }
      setTimeout(refreshStatus, 300);
    });
    $('scopeAll').addEventListener('change', (e) => save((s) => (s.scope = e.target.checked ? 'all' : 'ask')));
    $('mode').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) save((s) => (s.mode = b.dataset.v));
    });
    $('depth').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) save((s) => (s.depth = b.dataset.v));
    });
    $('contrast').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) save((s) => (s.textContrast = Number(b.dataset.v)));
    });
    for (const id of ['images', 'hairlines', 'canvasIslands', 'prompt']) {
      $(id).addEventListener('change', (e) => save((s) => (s[id] = e.target.checked)));
    }
    $('openOptions').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }

  async function init() {
    // ?tab=<id> renders the popup for a given tab (used by scripts/screenshots.mjs,
    // where the popup is opened as a page instead of from the toolbar).
    const forced = Number(new URLSearchParams(location.search).get('tab'));
    if (forced) tab = await chrome.tabs.get(forced).catch(() => null);
    if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { settings: raw } = await chrome.storage.local.get('settings');
    settings = S.withDefaults(raw);
    try {
      const cmds = await chrome.commands.getAll();
      const c = cmds.find((x) => x.name === 'toggle-site');
      if (c && c.shortcut) $('shortcut').textContent = `${c.shortcut} toggles this site`;
      else $('shortcut').textContent = '';
    } catch (_) {
      /* ignore */
    }
    bind();
    render();
    refreshStatus();
  }

  init();
})();
