# How Safari's Adaptive Dark Mode works, and how this extension reproduces it

Research notes behind the extension. This is an independent project, not affiliated with or endorsed by Apple. Safari and WebKit are trademarks of Apple Inc. Each statement is tagged by where it comes from:

- **[blog]** Apple's announcement, *Introducing Adaptive Dark Mode*, WebKit blog, Nov 3 2026.
- **[webkit]** The open-source WebKit tree (`main` at `78cf51b6`, Nov 10 2026) and its commit messages.
- **[measured]** Pixel measurements from the before/after screenshots Apple published in the blog post.
- **[design]** Decisions made for this extension. These are not Apple's.

The core of Safari's engine (`AXCustomColorModeController`, `AXCustomColorBackdropContext`, `AXCustomColorSVGClassifier`) lives in Apple's closed *WebKitAdditions*. The open source contains only the hooks that call into it. Nobody outside Apple can see the exact decision logic. What follows is everything that can be established, plus a model fitted to Apple's own screenshots.

---

## 1. What Apple says it does [blog]

- **Gate.** It's enabled by the user, only while the system appearance is dark. Safari offers a preview on bright pages ("Tap 'Try'").
- **Opt-out.** Pages declaring `<meta name="color-scheme" content="light dark">` or `color-scheme: light dark` are not changed at all. `light only` (meta or CSS) asks to never be transformed, and can target specific elements. (The `only` keyword wasn't yet supported in 27.3 beta 1.)
- **Detection.** For every other page it samples the colors and estimates whether the page is mostly light or mostly dark. Dark pages are left alone.
- **Color.** A color matrix inverts the lightness of colors and keeps their hue. Light backgrounds go dark and dark text goes light. Text aims for **WCAG 4.5:1**. Light CSS gradients are transformed. Decorative and semantic colors are judged separately, so buttons keep contrast against their backgrounds, text stays readable over images and hover menus stay clear.
- **Images.** Most are untouched. SVGs are inspected and recolored when needed. Bitmaps get a pixel-histogram analysis, and simple black-and-white logos are inverted.
- **Effects.** Masks and `mix-blend-mode` are turned off in some cases. `<canvas>` is left unchanged.
- **Privacy.** Undetectable by pages. JavaScript reading CSS colors gets the authored values, and images drawn into canvas keep their original form.
- **Author advice.** Prefer SVG logos over bitmaps, CSS colors and gradients over tiled images, and transparent image backgrounds. For a custom look in one region, set `color-scheme: light dark` on that element and style it yourself.

## 2. What the open-source engine reveals [webkit]

| Finding | Where |
|---|---|
| Internal name **AX Custom Color Mode**; preference `AXCustomColorModeEnabled`; layout tests live in `LayoutTests/adaptive-dark-mode/`. | `UnifiedWebPreferences.yaml`, commit `2c2a4add55` |
| **Detection runs at `didReachVisuallyNonEmptyState`** and resets per page load. State is sent to the UI process (Safari's "Try" offer). | commit `5a1e7b740f` |
| **Two-phase "fake paint"**: `AXCustomColorCollectBackgrounds` records every box that paints a background (blocks, inline boxes, replaced elements, tables, table rows). `AXCustomColorComputeBackdrops` then computes, for each text run and replaced element, what paints behind it. | `PaintPhase.h`, `RenderLayer.cpp`, `TextBoxPainter.cpp`, commits `f2468d106a`, `ae198dd4e1`, `6233469583` |
| **Text colors are adjusted at paint time** (`adjustTextPaintStyle`) using those backdrops. Backdrops are recomputed after repaints (`setNeedsTextBackdropUpdate`). | `TextPaintStyle.cpp`, `RenderLayerBacking.cpp`, commit `ef0952e251` |
| **Box shadows** go through a hook that can tell a real drop shadow from a zero-blur, zero-offset shadow "standing in for a border". | `BackgroundPainter.cpp`, commit `c5c4584117` |
| **Surface hairlines** are painted when needed, after backgrounds (`paintSurfaceHairlineIfNecessary`). | commit `c7346f7532` |
| **Outline colors** have their own adjustment hook. | `OutlinePainter.cpp`, commit `47bc28e76b` |
| **SVG**: a per-SVG classifier (`AXCustomColorSVGClassifier::Characteristics`), with per-paint fill/stroke adjustment (`adjustedSVGPaintColor`). Whether an SVG image is changed is decided per use, not once per file. | `SVGPaintServerHandlingInlines.h`, commits `7a8ebb6f95`, `73969fece7` |
| **Bitmaps**: three paint-time outcomes, `Unchanged`, `SimpleInvert` and `ColorPreservingInvert`. Only the drawn part of a bitmap is classified (sprites), and raster background images can be inverted. Direct compositing is turned off for images that must be inverted, because a directly composited image is never painted. | `ImageTypes.h`, `GraphicsContextCG.cpp`, commits `a2c934a413`, `b5d0911616` |
| **Quirks**: the embedder can force-disable the mode per site, for the main frame and subframes (`_forceDisableAXCustomColorMode`). Per-element quirk selectors can force the filter on or preserve authored colors. | commits `f8d416f118`, `8747e68612` |
| **Non-observability**: style resolution differentiates `StyleColorOptionsPurpose::ComputedStyle` from `::Rendering`. Computed values stay authored and only painting changes. Even the canvas focus-ring color is kept unobservable, and fingerprinting tests assert that form-control computed styles don't change. | commits `369f5fbfa3`, `e2cb413f64`, `9dad621360`, `bab63831f8` |
| **System colors are semantic**: UA link colors were marked semantic so the color filter doesn't touch them, and form controls use the dark appearance. | commits `6f60a8837e`, `d47c6f0a81` |
| Other details: `-webkit-named-image()` uses a variant suited to the changed surface. The under-page background color and sampled top color follow the transform. It's disabled while printing. The page keeps visual continuity when restored from the back/forward cache. | commits `639e07c705`, `46e02de0bc`, `947d7759d6`, `f3a15c44e7`, `69e2d75a08` |
| The 2018 `-apple-invert-lightness()` matrix (used by Mail's dark mode) rotates hue 180° in HSL, then applies `[-0.770 0.059 -0.089 1; 0.030 -0.741 -0.089 1; 0.030 0.059 -0.890 1]`. It maps white to `#333`. Whether ADM's `colorPreservingInvertMatrix()` is the same matrix is not visible. | `StyleAppleInvertLightnessFunction.cpp` |

## 3. Calibration from Apple's screenshots [measured]

Matching flat regions in the light and adapted halves of the two blog screenshots:

| Element | Light | Safari ADM | Note |
|---|---|---|---|
| Interop page (white) | `#ffffff` | `#1e1e1e` | white maps to the macOS dark window color |
| Card on tinted page | CR 1.163 vs page | CR 1.17 vs page | **WCAG contrast between surfaces is preserved** |
| Paragraph text | `#4a4a4a` | `#bebebe` | |
| Link | `#4470e2` (Y .183) | Y .229 | vivid text is lightened **just** to ~4.5:1 |
| Teal / blue badges | `#48a096` / `#354af5` | unchanged | vivid surfaces keep their color |
| Lime chip | `#ceee56` | `#bbd750` | very light vivid surfaces are dimmed a little |
| Dark text on lime chip | dark | stays dark | text polarity follows the **actual backdrop** |
| Large dark card | `#1a3a48` | unchanged | already-dark large surfaces stay |
| Small dark "Plan" pill | `#142937` | `#d5eaf6` | small dark controls flip to light |
| Dark-ink logo tile | dark tile, light glyph | light tile, dark glyph | logo inverted as a whole |
| Chart canvas, map image, hero photo | — | unchanged | |

**Fitted model [design].** Neutral and tinted colors are flipped with `Y' + 0.05 = k / (Y + 0.05)`, where `k` pins white to the dark anchor (`#1e1e1e` by default). In `(Y + 0.05)` space this is an involution, so every WCAG ratio between two flipped colors is preserved exactly. That's the property the card/page measurement shows, and it reproduces `#4a4a4a → #bdbdbd` (Safari: `#bebebe`). Hue and chroma are kept in OKLCH. Colors with OKLCH chroma ≥ 0.08 (surfaces) or ≥ 0.15 (text) count as semantic. Surfaces keep their color, and text is lightened only to the target, giving Y 0.233 for the link (Safari: 0.229). Apple's ArdenGo screenshot maps white closer to `#333`, which is the "Soft" depth.

## 4. Safari mechanism → extension equivalent [design]

| Safari (in-engine) | Extension |
|---|---|
| Style adjuster transforms colors for every element | **Rule-level overrides.** Every author declaration of a color property is mirrored, changed or not, with the same selector, inside the same `@media`/`@supports`/`@layer`/`@container`/`@scope`/nesting context, in constructed sheets adopted after the page's sheets. Equal specificity plus later order means our value wins. Mirroring unchanged declarations too keeps the page's own cascade intact: a later `.btn--ghost { background: transparent }` still beats an earlier, transformed `.btn` rule. Covers `:hover`, pseudo-elements, keyframes, cross-origin sheets (fetched by the service worker), `@import` chains, shadow roots (open and closed), CSS-in-JS (`insertRule`, signaled from a main-world hook), inline styles and legacy `bgcolor`/`<font color>`. |
| CSS variables resolve before painting | Every color-carrying custom property gets role variants (`--adm-bg-x`, `--adm-fg-x`, `--adm-bd-x`, `--adm-sh-x`). Each color-role use of `var(--x)` is rewritten to `var(--adm-<role>-x, var(--x))`. Channel-triplet variables (shadcn `0 0% 100%`, Bootstrap `255, 255, 255`) are handled. When CSSOM loses a `var()` shorthand (followed by its own longhand), the declaration is recovered from the sheet's source text. |
| `AXCustomColorComputeBackdrops` | **Layout pass**: text entering the viewport is hit-tested (`elementsFromPoint`) to find what really paints behind it. Text over images or video keeps its authored color. All other text is pushed to 4.5:1 (3:1 for large text). Off-screen candidates get a provisional ancestor-chain pass and a precise one once visible. |
| Small dark controls, hairlines | Same rules, applied in the layout pass. |
| SVG classifier | Per-`<svg>` composition check. Dark app-icon tiles invert as a whole, artwork with its own light canvas is left alone, and neutral paints with lost contrast are flipped. `<img src=*.svg>` is classified from its markup. |
| Bitmap histogram, ColorPreservingInvert | Same histogram idea (`src/shared/imageclass.js`). Cross-origin bitmaps are decoded in the service worker on an `OffscreenCanvas`, so the page canvas isn't tainted. The result is applied as `invert(1) hue-rotate(180deg)`. Light tiled textures are replaced by their average color, flipped. |
| Canvas untouched | Canvas pixels are untouched. A chart drawn dark-on-transparent (an origin-clean canvas, read without touching its context) keeps a light backdrop, a "light island" like Safari's Interop chart. WebGL heroes and other decorative canvases get nothing. |
| `forceDisable` and element quirks | Built-in and user quirks: disable per site, `forceInvert` selectors, `preserve` selectors. |
| System colors semantic, dark form controls | `:root { color-scheme: dark }` in the top frame, so UA colors, links, controls and scrollbars use their dark variants. System color keywords are never rewritten. `<iframe>` elements keep the page's original scheme. A transparent light iframe whose scheme stops matching its element gets an opaque white canvas, which would cover the page (seen on a consent overlay). |
| Disabled while printing | All overrides are wrapped in `@media screen`. |
| "Try" preview | In-page offer card (closed shadow root), toolbar badge, popup, and the ⌥⇧D shortcut. |

## 5. What an extension cannot match

- **Unobservability.** Safari keeps computed styles authored and only changes paint. An extension can only change paint by changing styles, so `getComputedStyle`, `adoptedStyleSheets`, `data-adm-*` attributes and the main-world hook are all visible to page scripts. This extension does not patch `getComputedStyle` to hide itself.
- **Per-paint decisions.** Safari decides per paint of each run. The extension decides per element, so a `:hover` color change on an element we fixed is overridden by the fix.
- **Partial-image classification.** Safari classifies only the drawn region of a sprite. The extension classifies the whole sprite and only acts on icon-sized boxes.
- **First paint.** Pages from sites already known to be bright start at `document_start` from a cached verdict. On a first visit there is one detection pass after DOMContentLoaded.

## Sources

- [Introducing Adaptive Dark Mode — WebKit blog](https://webkit.org/blog/18541/introducing-adaptive-dark-mode/)
- [WebKit source](https://github.com/WebKit/WebKit): the commits listed above, `LayoutTests/adaptive-dark-mode/`, `Source/WebCore/style/values/filter-effects/StyleAppleInvertLightnessFunction.cpp`, `Websites/webkit.org/wp-content/themes/webkit/images/invert-lightness.svg`
- Coverage of the release: [MacRumors](https://www.macrumors.com/2026/11/03/ios-27-3-safari/), [PPC Land](https://ppc.land/safaris-new-dark-mode-repaints-light-websites-without-the-sites-knowing/), [DEV Community](https://dev.to/leobaniak/safari-273-beta-will-dark-mode-your-light-site-unless-your-css-says-otherwise-3h4c)
