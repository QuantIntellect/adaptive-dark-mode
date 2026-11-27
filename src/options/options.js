/* Adaptive Dark Mode — options page. */
(function () {
  'use strict';
  const S = globalThis.ADM.settings;
  const $ = (id) => document.getElementById(id);
  let settings = S.withDefaults(null);

  const el = (tag, props = {}, children = []) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    for (const c of [].concat(children)) n.append(c);
    return n;
  };

  function normalizeHost(input) {
    let h = String(input || '').trim().toLowerCase();
    if (!h) return '';
    try {
      if (/^[a-z]+:\/\//.test(h)) h = new URL(h).hostname;
    } catch (_) {
      /* keep raw */
    }
    return S.siteKey(h.replace(/\/.*$/, ''));
  }

  async function load() {
    const { settings: raw } = await chrome.storage.local.get('settings');
    settings = S.withDefaults(raw);
    render();
  }

  async function save(mutate) {
    const { settings: raw } = await chrome.storage.local.get('settings');
    const next = S.withDefaults(raw);
    mutate(next);
    await chrome.storage.local.set({ settings: next });
    settings = next;
    render();
  }

  function render() {
    const sites = $('sites');
    sites.replaceChildren();
    for (const host of Object.keys(settings.sites).sort()) {
      const v = settings.sites[host];
      sites.append(el('div', { className: 'tr' }, [
        el('span', { className: 'host', textContent: host }),
        el('span', { className: `badge ${v}`, textContent: v === 'on' ? 'Always' : 'Never' }),
        el('button', { className: 'link', textContent: 'Remove', onclick: () => save((s) => delete s.sites[host]) }),
      ]));
    }

    const quirks = $('quirks');
    quirks.replaceChildren();
    for (const host of Object.keys(settings.quirks).sort()) {
      const q = settings.quirks[host];
      const bits = [];
      if (q.disable) bits.push('disabled');
      if (q.forceInvert) bits.push(`invert: ${q.forceInvert}`);
      if (q.preserve) bits.push(`preserve: ${q.preserve}`);
      quirks.append(el('div', { className: 'tr' }, [
        el('span', { className: 'host', textContent: host }),
        el('button', { className: 'link', textContent: 'Edit', onclick: () => editQuirk(host) }),
        el('button', { className: 'link', textContent: 'Remove', onclick: () => save((s) => delete s.quirks[host]) }),
        el('span', { className: 'detail', textContent: bits.join(' · ') || 'no changes' }),
      ]));
    }

    const builtins = $('builtins');
    builtins.replaceChildren();
    for (const [host, q] of Object.entries(S.BUILTIN_QUIRKS)) {
      const bits = [];
      if (q.disable) bits.push('disabled');
      if (q.forceInvert) bits.push(`invert: ${q.forceInvert}`);
      if (q.preserve) bits.push(`preserve: ${q.preserve}`);
      builtins.append(el('div', { className: 'tr' }, [
        el('span', { className: 'host', textContent: host }),
        el('span', { className: 'badge', textContent: q.note || '' }),
        el('span', {}),
        el('span', { className: 'detail', textContent: bits.join(' · ') }),
      ]));
    }
  }

  function editQuirk(host) {
    const q = settings.quirks[host] || {};
    for (const id of ['qInvert', 'qPreserve']) $(id).setCustomValidity('');
    $('qHost').value = host;
    $('qDisable').checked = !!q.disable;
    $('qInvert').value = q.forceInvert || '';
    $('qPreserve').value = q.preserve || '';
    $('qHost').focus();
  }

  const parses = (sel) => {
    try {
      document.createDocumentFragment().querySelector(sel);
      return true;
    } catch (_) {
      return false;
    }
  };

  // Split a selector list at its top-level commas (not inside :is(...),
  // [attr="a,b"] or quotes).
  function splitList(list) {
    const out = [];
    let depth = 0;
    let quote = '';
    let from = 0;
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '\\') i++;
      else if (ch === '(' || ch === '[') depth++;
      else if ((ch === ')' || ch === ']') && depth) depth--;
      else if (ch === ',' && !depth) {
        out.push(list.slice(from, i));
        from = i + 1;
      }
    }
    out.push(list.slice(from));
    return out.map((s) => s.trim());
  }

  /** '' when the list is valid, or a message that names the selector that isn't. */
  function selectorError(list) {
    if (!list || parses(list)) return '';
    const bad = splitList(list).find((s) => !s || !parses(s));
    if (bad === '') return 'Empty selector: remove the extra comma.';
    return bad ? `Not a valid CSS selector: ${bad}` : 'Not a valid CSS selector list.';
  }

  function bind() {
    $('addSite').addEventListener('submit', (e) => {
      e.preventDefault();
      const host = normalizeHost($('addHost').value);
      if (!host) return;
      const v = $('addValue').value;
      save((s) => (s.sites[host] = v));
      $('addHost').value = '';
    });
    // A message set on a field blocks the form's submit until it is cleared,
    // so it must go as soon as the field is edited. Otherwise one bad entry
    // made every later selector look invalid until a reload (#4).
    for (const id of ['qInvert', 'qPreserve']) $(id).addEventListener('input', (e) => e.target.setCustomValidity(''));
    $('addQuirk').addEventListener('submit', (e) => {
      e.preventDefault();
      const host = normalizeHost($('qHost').value);
      if (!host) return;
      const forceInvert = $('qInvert').value.trim();
      const preserve = $('qPreserve').value.trim();
      for (const [input, sel] of [[$('qInvert'), forceInvert], [$('qPreserve'), preserve]]) {
        input.setCustomValidity(selectorError(sel));
        if (!input.reportValidity()) return;
      }
      const q = {};
      if ($('qDisable').checked) q.disable = true;
      if (forceInvert) q.forceInvert = forceInvert;
      if (preserve) q.preserve = preserve;
      save((s) => {
        if (Object.keys(q).length) s.quirks[host] = q;
        else delete s.quirks[host];
      });
      e.target.reset();
    });
    $('export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: 'adaptive-dark-mode-settings.json' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('import').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        await chrome.storage.local.set({ settings: S.withDefaults(parsed) });
        $('dataNote').textContent = 'Settings imported.';
        load();
      } catch (_) {
        $('dataNote').textContent = 'That file is not a settings export.';
      }
      e.target.value = '';
    });
    $('clearVerdicts').addEventListener('click', async () => {
      await chrome.storage.local.remove('verdicts');
      $('dataNote').textContent = 'Brightness cache cleared. Pages are re-checked on the next visit.';
    });
    $('reset').addEventListener('click', async () => {
      if (!confirm('Reset all Adaptive Dark Mode settings and site choices?')) return;
      await chrome.storage.local.set({ settings: S.withDefaults(null) });
      await chrome.storage.local.remove('verdicts');
      $('dataNote').textContent = 'Everything was reset.';
      load();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        settings = S.withDefaults(changes.settings.newValue);
        render();
      }
    });
  }

  bind();
  load();
})();
