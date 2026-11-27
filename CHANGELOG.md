# Changelog

## 1.0.4 — 2026-11-27

Fixes for pages that froze, and for the quirk form on the options page.

- Fixed ([#5](https://github.com/QuantIntellect/adaptive-dark-mode/issues/5)): pages could stop responding. Four
  ways the extension could end up answering its own changes, found on an Oracle careers page and in tests:
  - An inline `!important` color was transformed again on every pass, and transforms don't settle (a border color
    keeps changing). With nothing else to adjust on the element, each pass was a new style change that the extension
    then answered, in microtasks, so the page never painted or took input again. One element with
    `style="border-color: #f0f0f0 !important"` was enough. Now the original value is kept and only transformed once,
    and it is put back when the mode turns off (unless the page changed it in the meantime).
  - Text over a large background photo was checked again on every frame, because the photo is never classified
    (photos are left alone) and the "classified, look again" step ran anyway. On the Oracle page that rewrote the
    same attributes 60 times a second, and the site's UI library (Oracle JET) re-renders components when attributes
    under them change. Text is now checked again only when the image actually got a verdict.
  - Adjustments are written only when their value changes. A write of the same value still reaches the page's own
    observers, and some re-render on any change.
  - Attribute changes that leave the value as it was (a framework re-applying the same classes) are ignored.
- A safety net for loops not covered above. Within one task an element is handled a few times at most. After 100
  observer callbacks in one task, the rest waits for the next task, and if that happens three tasks in a row the
  work is dropped until things calm down. Elements that keep coming back to the layout pass on every frame are looked
  at again a second later. When this happens, the popup's statistics line says "loops stopped".
- Fixed ([#4](https://github.com/QuantIntellect/adaptive-dark-mode/issues/4)): after one invalid selector in the
  options page's quirk form, every selector was rejected as "Not a valid CSS selector" until the page was reloaded
  (the message stayed set on the field and blocked the form). The message now clears as soon as the field is edited,
  and it names the selector that's wrong. The placeholders no longer read like part of the value ("Invert, e.g.
  .chart img, .logo").
- Tests: a fixture with the loops above (an inline `!important` border, text over a photo, a component that
  re-applies its children's classes, and one that re-renders fresh children whenever an attribute under it changes),
  checked for a page that still answers, no attribute rewritten while idle, a stable border and colors restored on
  turning off. Three checks for the quirk form.

## 1.0.3 — 2026-11-20

Sites that have a dark theme of their own, switched off in their own settings.

- No **Try** offer on sites that have a dark theme of their own, switched off in the site's own settings: YouTube
  set to its light theme (`html[dark]`), Stack Overflow (`body.theme-dark`), Wikipedia
  (`html.skin-theme-clientpref-night`), GitHub-style `[data-color-mode=dark]` with the attribute on `<html>`, or root
  colors in a `prefers-color-scheme: dark` block that the site's setting gates (the block matches, the rule doesn't
  match the root). The card no longer appears there, the toolbar badge shows nothing, and the popup says **Site's own
  dark theme is off**, with **Try on this page** still available. **All bright sites** and sites you turned on are
  adapted as before. The check runs only while the system is dark: with **Always** on a light system, sites that
  follow the system still get the offer, and **Try** uses their own dark CSS.
- Dark *section* styles are not taken for a site theme: `.theme-dark` used on a promo band (Apple, IKEA,
  Microsoft), Bootstrap's `.bg-dark`/`.btn-dark`, and blocks that libraries ship to every site using them: Bootstrap
  5.3's `[data-bs-theme=dark]` and Algolia DocSearch's `html[data-theme=dark]` count only when the site sets that
  attribute on its root. A dark media block that applies but only restyles a widget doesn't count either.
- The offer card now appears after the page's `load` event (at most 3 s after the first check), when the check for
  the site's own theme has seen its style sheets. It used to appear right after DOMContentLoaded.
- Tests: selector-grammar unit tests from real sites, and nine end-to-end checks (five kinds of own theme, the
  popup, a page of dark sections and library blocks, a widget-only dark block, and Always on a light system, which
  must all still get the offer). The own-theme rule in `light.html` moved into the theme-switch check, since a page
  that ships one no longer gets the offer. The offer checks wait for the card instead of a fixed time.

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
