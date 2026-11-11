/*
 * Adaptive Dark Mode — the in-page offer.
 *
 * Safari: "browse to a website with a bright background. Safari will offer a
 * preview of Adaptive Dark Mode. Tap 'Try'." This is the extension's version:
 * a small card in a closed shadow root, shown only in the top frame, only
 * while the system is dark, and at most once per page view.
 */
(function (root) {
  'use strict';
  const ADM = root.ADM;

  let hostEl = null;
  let shadow = null;
  let hideTimer = 0;

  const CSS = `
    :host { all: initial; }
    .card {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: flex; align-items: center; gap: 12px;
      max-width: min(440px, calc(100vw - 32px));
      padding: 10px 10px 10px 14px; border-radius: 14px;
      background: rgb(36 36 38 / 0.94); color: #f5f5f7;
      -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px);
      box-shadow: 0 0 0 0.5px rgb(255 255 255 / 0.12), 0 10px 30px rgb(0 0 0 / 0.35);
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      letter-spacing: -0.01em; -webkit-font-smoothing: antialiased;
      opacity: 0; transform: translateY(8px) scale(0.98);
      transition: opacity 220ms cubic-bezier(.2,.8,.2,1), transform 260ms cubic-bezier(.2,.8,.2,1);
    }
    .card.in { opacity: 1; transform: none; }
    .icon { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center;
      background: linear-gradient(135deg, #3a3a3c, #1c1c1e); box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.15); }
    .text { flex: 1; min-width: 0; }
    .title { font-weight: 600; }
    .sub { color: #a1a1a6; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; gap: 6px; flex: none; }
    button {
      all: unset; cursor: pointer; padding: 6px 12px; border-radius: 8px; font-weight: 500;
      color: #f5f5f7; background: rgb(255 255 255 / 0.08); transition: background 120ms ease, transform 120ms ease;
    }
    button:hover { background: rgb(255 255 255 / 0.14); }
    button:active { transform: scale(0.97); }
    button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
    button.primary { background: #0a84ff; color: #fff; }
    button.primary:hover { background: #2b95ff; }
    @media (prefers-reduced-motion: reduce) { .card { transition: opacity 120ms linear; transform: none; } }
  `;

  const MOON = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="#f5f5f7" d="M9.6 1.2a6.8 6.8 0 1 0 5.2 9.6A5.6 5.6 0 0 1 9.6 1.2Z"/></svg>`;

  function ensure() {
    if (hostEl && hostEl.isConnected) return;
    hostEl = document.createElement('adm-offer');
    hostEl.setAttribute('data-adm-x', '');
    shadow = hostEl.attachShadow({ mode: 'closed' });
    (document.body || document.documentElement).appendChild(hostEl);
  }

  function render({ title, sub, buttons, autoHideMs, onTimeout }) {
    ensure();
    clearTimeout(hideTimer);
    shadow.innerHTML = `<style>${CSS}</style><div class="card" role="dialog" aria-live="polite" aria-label="Adaptive Dark Mode">
      <div class="icon">${MOON}</div>
      <div class="text"><div class="title"></div><div class="sub"></div></div>
      <div class="actions"></div></div>`;
    const card = shadow.querySelector('.card');
    shadow.querySelector('.title').textContent = title;
    shadow.querySelector('.sub').textContent = sub;
    const actions = shadow.querySelector('.actions');
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.primary) el.className = 'primary';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        b.onClick();
      });
      actions.appendChild(el);
    }
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')));
    if (autoHideMs) {
      const arm = () => (hideTimer = setTimeout(() => {
        hide();
        if (onTimeout) onTimeout();
      }, autoHideMs));
      card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      card.addEventListener('mouseleave', arm);
      arm();
    }
  }

  function hide() {
    clearTimeout(hideTimer);
    if (!shadow) return;
    const card = shadow.querySelector('.card');
    if (!card) return;
    card.classList.remove('in');
    setTimeout(() => {
      if (hostEl) hostEl.remove();
      hostEl = null;
      shadow = null;
    }, 260);
  }

  function offer({ host, onTry, onDismiss }) {
    render({
      title: 'This page is bright',
      sub: `Try Adaptive Dark Mode on ${host}`,
      buttons: [
        { label: 'Not now', onClick: () => { hide(); onDismiss(); } },
        { label: 'Try', primary: true, onClick: onTry },
      ],
      autoHideMs: 15000,
      onTimeout: onDismiss,
    });
  }

  function applied({ host, onAll, onUndo }) {
    render({
      title: 'Adaptive Dark Mode is on',
      sub: `Remembered for ${host}`,
      buttons: [
        { label: 'Undo', onClick: () => { hide(); onUndo(); } },
        { label: 'All bright sites', primary: true, onClick: () => { hide(); onAll(); } },
      ],
      autoHideMs: 8000,
    });
  }

  ADM.prompt = { offer, applied, hide };
})(globalThis);
