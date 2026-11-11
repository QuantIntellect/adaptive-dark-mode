# Changelog

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
