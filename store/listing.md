# Chrome Web Store submission kit

Everything the Chrome Web Store developer dashboard asks for, ready to paste. The developer account, the one-time
registration fee, signing in and pressing **Submit for review** are done by the publisher.

- Package: `npm run pack` → `dist/adaptive-dark-mode-<version>.zip`. It contains only `manifest.json`, `src/` and the
  16/32/48/128 icons, with no tests or docs.
- Dashboard: <https://chrome.google.com/webstore/devconsole> → **New item** → upload the zip.

---

## Store listing tab

**Item name**

```
Adaptive Dark Mode
```

**Summary** (from `manifest.json`, at most 132 characters)

```
Presents light websites as dark while you browse in dark mode, keeping hue, contrast, logos and images right.
```

**Description**

```
Adaptive Dark Mode turns bright websites dark while your system or Chrome is in dark mode. It changes colors without breaking the page.

• Light surfaces become dark and dark text becomes light, with the hue kept.
• Brand colors, badges and buttons keep their color. Links are lightened just enough to read.
• Text is checked against what is actually painted behind it and pushed to WCAG 4.5:1 contrast (7:1 optional).
• Photos, video and canvas are left alone. Simple black-and-white logos and dark icons are inverted so they stay visible.
• Sites that already have a dark theme, or declare their own color scheme, are left untouched.
• A small "This page is bright · Try" card lets you preview it per site, or turn it on for all bright sites.
• Alt+Shift+D toggles the current site.

Settings: darkness (Soft, Standard, Deep, Black), text contrast, logo and icon handling, surface edges, chart islands, per-site on/off and per-site quirks.

Private by design: no account, no analytics, no server. Everything runs in your browser.

Inspired by the Adaptive Dark Mode feature introduced in Safari 27.3. This is an independent project and is not affiliated with or endorsed by Apple. Open source: https://github.com/QuantIntellect/adaptive-dark-mode
```

**Category**: Accessibility (under Make Chrome Yours)

**Language**: English

**Graphic assets**

| Field | File |
|---|---|
| Store icon (128×128) | `icons/icon128.png` |
| Screenshots (1280×800) | `store/screenshots/1-before-after.png`, `2-adapted.png`, `3-popup.png`, `4-try-offer.png` |
| Small promo tile (440×280) | `store/promo-440x280.png` |

All screenshots are rendered from the project's own test page by `npm run screenshots`. None show third-party sites.

**Official URL / homepage**: `https://github.com/QuantIntellect/adaptive-dark-mode`

**Support URL**: `https://github.com/QuantIntellect/adaptive-dark-mode/issues`

---

## Privacy tab

**Single purpose**

```
Displays light web pages in a dark color scheme, adjusting their colors, text contrast and simple logos, while the user
browses in dark mode.
```

**Permission justifications**

| Permission | Justification |
|---|---|
| `storage` | Stores the user's settings, per-site on/off choices and a local cache of which sites are light or dark, so pages can be adapted from the start of loading. Nothing leaves the device. |
| Host permission `<all_urls>` | The extension's single purpose is to restyle whichever light page the user opens, so it must run on any site. It also needs host access to read cross-origin style sheets and small logo images the page already loaded. Chrome blocks content scripts from reading those, so the service worker re-requests them without cookies. |
| Content script in the main world (`src/content/page-hook.js`) | Only dispatches an event when the page changes its style sheets from JavaScript (CSS-in-JS), so new rules are adapted too. It reads and sends no data. |

**Remote code**: No, I am not using remote code. All JavaScript is in the package. Fetched style sheets are parsed as
CSS text, never executed.

**Data usage**

The Web Store's user data FAQ says data that is only processed or stored on the device must still be disclosed.
Check **Website content** (colors, style sheets and image pixels are read to restyle the page) and **Web history**
(the local brightness cache keeps site names with a timestamp). Leave every other category unchecked.

Certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**: `https://github.com/QuantIntellect/adaptive-dark-mode/blob/main/PRIVACY.md`

---

## Distribution tab

- Visibility: **Public** (or **Unlisted** for a soft launch; the link still works for anyone who has it).
- Regions: all.

## Test instructions (optional field, shown to the reviewer)

```
The extension only acts while the system or browser uses a dark color scheme. To test with a light system theme,
open the toolbar popup and set "Runs" to "Always". Then open any light website, e.g. https://news.ycombinator.com/.
A "This page is bright · Try" card appears in the bottom-right corner. Click Try, or toggle the site in the popup.
```

## Notes

- Requesting `<all_urls>` usually means an in-depth review that takes longer than a few days.
- The popup (screenshot 3) labels the contrast option "4.5:1 · Safari" and says the Try offer works "like Safari does".
  If a reviewer objects to the brand name, change those two strings in `src/popup/popup.html` and re-run
  `npm run screenshots`.
- Keep "Safari" out of the item name and summary. The description mentions it once, factually, with a
  non-affiliation line. Remove that paragraph if a reviewer objects.
- To ship an update, bump `version` in `manifest.json` and `package.json`, run `npm run pack`, then upload the new zip
  in the dashboard under **Package**.
