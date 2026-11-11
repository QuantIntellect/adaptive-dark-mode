# Changelog

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
