# Privacy policy

*Adaptive Dark Mode for Chrome. Effective November 11, 2026.*

Adaptive Dark Mode changes how web pages look on your own computer. It has no server, no account, no analytics and no
advertising. The developer receives no data from it.

## What the extension reads

To present a light page as dark, the extension reads the page's colors, style sheets and the size and color content of
some images. This happens inside your browser and the results are never sent anywhere.

## Network requests it makes

Chrome does not let extensions read the rules of a style sheet loaded from another origin, or the pixels of an image
from another origin. To read them, the extension's background service worker requests those files again:

- **Cross-origin style sheets** that the page has already loaded.
- **Small images** (logos and icons) to decide whether they are dark-on-transparent and need inverting, and a
  photo only when text sits on top of it.

These requests go only to the same URLs the page itself already requested. They are sent **without cookies or other
credentials** (`credentials: "omit"`). Nothing about you or the page is added to them. No request is sent to the
developer or to any third party.

## What it stores

Everything is kept in `chrome.storage.local` on your device. Nothing is synced or uploaded.

- **Settings**: on/off mode, darkness, text contrast and the other options in the popup.
- **Per-site choices**: sites you switched on or off, "Not now" answers to the Try offer, and your own quirk rules.
- **A brightness cache**: for sites you visit, the site name (for example `example.com`) and whether the page looked
  light, dark, or declared its own color scheme, with the time it was recorded. It lets the extension start before a
  page finishes loading on your next visit. It holds at most about 3,000 sites, and the oldest entries are dropped.

In the Chrome Web Store's data categories, the extension therefore handles **website content** (page colors, style
sheets and image pixels, read to restyle the page) and **web history** (the site names in the brightness cache). Both
are handled only on your device.

Removing the extension deletes all of this. Settings and site choices can also be reset from the options page.

## Permissions

| Permission | Why |
|---|---|
| Read and change data on all websites (`<all_urls>`) | The extension restyles any light page you open, including style sheets and frames from other origins. |
| `storage` | Saves the settings, site choices and brightness cache listed above. |

## Data sharing

None. The extension does not sell, transfer or share user data, does not use it for anything other than restyling pages,
and does not use it for creditworthiness or lending purposes.

## Contact

Questions or concerns: open an issue at <https://github.com/QuantIntellect/adaptive-dark-mode/issues>.
