# Changelog

## 1.0.2 — 2026-11-19

Fixes for the first reports from users, and a tidier popup. Chrome Web Store users update from 1.0.0 to this version
directly, so it also carries the 1.0.1 changes below.

- Fixed ([#1](https://github.com/QuantIntellect/adaptive-dark-mode/issues/1)): white flash while a page loads. On a
  site you turned on (or with **Use on all bright sites**), the first visit now starts dark at `document_start`,
  before any content arrives, instead of after the first check at DOMContentLoaded. If the page turns out to be dark
  already, the extension steps aside on that first check and remembers it. Embedded frames still wait for the check.
- Fixed ([#2](https://github.com/QuantIntellect/adaptive-dark-mode/issues/2)): a drawing made of stacked canvases
  (paint.toys' Zen Garden: stones drawn on a transparent canvas above the sand) was treated as a chart, and the light
  backdrop meant for charts covered the sand. A canvas drawn over another canvas, image or video (one that lets the
  pointer through, the usual way such layers are built) no longer gets one. A chart with a hover layer above it keeps
  its backdrop.
- Fixed (new in 1.0.1, not released to the store): a cookie-consent dialog with a dark backdrop (for example Google's
  consent dialog: fixed, black at 60% opacity) was read as the site switching to its own dark theme, and the extension
  turned itself off while the dialog was open. Fixed overlays stacked above the page are no longer taken for the page,
  and opacity counts toward how opaque a full-page wrapper is.
- Fixed: clicking **Try** could start the engine twice when the "remember this site" setting arrived before the
  page's transition began. The orphaned copy kept changing the page, so later setting changes didn't fully apply.
- Offer card: if it disappears unanswered, it asks again the next day, not after a week (**Not now** still means a
  week). Its buttons ignore clicks for half a second after it appears, so a double-click on **Try** can't land on
  **All bright sites**. **All bright sites** is no longer styled as the main button.
- Popup: **Try on this page** now remembers the site, as **Try** on the page does. A **Something looks wrong?** row
  on adapted pages offers **Leave canvases unchanged here** (adds a `canvas` preserve quirk for the site, keeping its
  other quirks) and **Turn off on this site**. The four switches moved under **Fine-tuning**, so the popup fits Chrome's
  600 px popup height (552 px, was 696 px). Pages that were open before an install or update show **Reload page**.
- Contrast: filled buttons use `#0066dd` (white text at 5.3:1, was 3.65:1); links are `#0066dd` in light mode and
  `#409cff` in dark mode; the options page's site badges use dark text.
- Store screenshots redesigned, five instead of four, rendered from three new demo sites in `store/demo/`: a
  product site, a magazine and a recipe site, with invented names and AI-generated photographs. Each image has a
  headline over a drawn browser window holding real 2x captures of the extension. They show a before/after split, all
  three sites adapted, close-ups (logos, status colors, article text), the popup, and the Try offer. The script checks
  that each page is in the state its caption claims (adapted, offer shown, logos inverted) before it saves an image.
- Tests: three fixtures (stacked canvases and a chart with a hover layer, a consent dialog, a page whose body arrives
  late) and eleven end-to-end checks, including one that starts from data saved by 1.0.0.

## 1.0.1 — 2026-11-11

Sites that already have their own automatic light/dark theme.

- Fixed: a site that applies its dark theme after load (for example a class set by the app after hydration) and paints
  its background on a full-page wrapper such as `#app` was not recognised as having turned dark. The extension stayed on
  over the site's own dark theme and brightened its borders. Theme switches are now detected from full-page wrappers
  too, and those wrappers are watched for class and `data-theme` changes.
- Fixed: the per-site light/dark cache now records the system appearance. A "light" verdict recorded in light mode no
  longer starts the extension early in dark mode, on sites that follow the system appearance themselves.
- New: rules inside `@media (prefers-color-scheme: dark)` are kept exactly as the author wrote them. With **Runs:
  Always** on a light system, those rules are switched on, so sites with their own dark CSS get their own dark design
  rather than a conversion of their light theme.
- Tests: three auto-theme fixtures and six end-to-end checks.

## 1.0.0 — 2026-11-11

First public release.

- Rule-level color overrides: every color declaration is mirrored in constructed style sheets after the page's own.
  The mirrored sheets keep each rule's `@media`, `@supports`, `@layer`, `@container`, `@scope`, nesting, `@keyframes`,
  `@import`, cross-origin sheets, shadow roots and CSS-in-JS context.
- Contrast-preserving luminance flip in OKLCH, calibrated against Apple's published Safari 27.3 screenshots. Four
  darkness levels, and 4.5:1 or 7:1 text.
- CSS variable role variants, including shadcn-style HSL and Bootstrap-style RGB channel triplets.
- Inline styles, inline `!important`, and legacy `bgcolor`, `<font color>` and `<body text>`.
- Layout pass: text contrast against the real backdrop, small dark controls, surface hairlines, inline SVG, chart
  islands for canvas.
- Image classification: black-and-white logos, dark icons, monochrome SVG, tiled light textures.
- Opt-outs: `color-scheme: light dark` / `light only` (meta, CSS, per element), already-dark pages, quirks.
- In-page "Try" offer, toolbar popup, options page, Alt+Shift+D.
- Unit tests and a Playwright end-to-end suite.
