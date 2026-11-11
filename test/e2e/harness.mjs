// Shared launcher: Chrome for Testing + the unpacked extension.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';

async function loadUnpacked(port, extPath) {
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const reply = await new Promise((resolve) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 1) resolve(msg);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: extPath } }));
  });
  ws.close();
  if (reply.error) throw new Error('Extensions.loadUnpacked: ' + reply.error.message);
  return reply.result.id;
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function findChrome() {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac', 'chrome-mac-x64']) {
        const p = path.join(base, d, arch, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
        if (fs.existsSync(p)) return p;
        const q = path.join(base, d, arch, 'Chromium.app/Contents/MacOS/Chromium');
        if (fs.existsSync(q)) return q;
      }
    }
  }
  throw new Error('No Chromium found: set CHROME=/path/to/chrome-for-testing');
}


/**
 * Chrome 137+ ignores --load-extension; the supported route is the CDP method
 * Extensions.loadUnpacked (needs --enable-unsafe-extension-debugging).
 * Playwright launches the browser (its flag set keeps networking and the
 * keychain sane on macOS); we add a debugging port and call the method on the
 * browser target.
 */
export async function launchWithExtension({ chromePath, userDataDir, repo, headed = false }) {
  const port = await freePort();
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromePath || findChrome(),
    headless: !headed,
    colorScheme: 'dark',
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--remote-debugging-port=${port}`, '--enable-unsafe-extension-debugging', '--force-dark-mode', '--hide-scrollbars'],
  });
  const extensionId = await loadUnpacked(port, repo);
  let sw = null;
  for (let i = 0; !sw && i < 75; i++) {
    sw = context.serviceWorkers().find((w) => w.url().includes(extensionId));
    if (!sw) await new Promise((r) => setTimeout(r, 200));
  }
  if (!sw) throw new Error('extension service worker did not start');
  const browser = { version: () => (context.browser() ? context.browser().version() : 'chrome-for-testing'), close: () => context.close() };
  return { context, sw, extensionId, browser };
}
