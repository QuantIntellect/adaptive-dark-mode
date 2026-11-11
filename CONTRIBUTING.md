# Contributing

Bug reports and pull requests are welcome.

## Reporting a page that looks wrong

Open an issue with:

- the URL, or a minimal HTML snippet that reproduces it,
- the extension's status from the popup (state, and the stats line),
- a screenshot with the extension on and off,
- the Chrome version, and the darkness and contrast settings.

## Development

The extension has no build step. Load the repository folder with **Load unpacked** at `chrome://extensions`. After
editing, click the reload icon on the extension's card and reload the page.

```
npm install             # playwright-core, used only by the e2e suite and the screenshot script
npm test                # unit tests (node:test): color math, calibration points, value rewriting, policy, classifiers
npm run e2e             # end-to-end checks on the fixtures in test/fixtures
npm run e2e -- --sites  # plus a handful of real websites
npm run screenshots     # regenerate store/screenshots and the promo tile
npm run pack            # dist/adaptive-dark-mode-<version>.zip
```

### Which Chrome the e2e suite uses

Chrome 137 and later ignore `--load-extension`, so the harness (`test/e2e/harness.mjs`) launches Chrome through
Playwright with `--enable-unsafe-extension-debugging` and loads the extension with the CDP method
`Extensions.loadUnpacked`.

- By default it uses Playwright's cached Chrome for Testing build. Set `CHROME=/path/to/binary` to choose another.
- **Branded Google Chrome**: in headless mode, Chrome 157 on macOS closed the test tab after about 30 seconds, with or
  without the extension. Run it headed instead:
  `HEADED=1 CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run e2e`.
- In headed Chrome 157 the pixel-identical "turned off" check fails by 1 to 15 levels around the two scaled product
  images, while the "nothing left behind" check passes. The cause has not been isolated.
- `--sites` adds one recorded (not pass/fail) result per reachable real website to the total.

## Guidelines

- Keep each fix covered by a fixture case in `test/fixtures/light.html` and a check in `test/e2e/run.mjs`, or a unit
  test for pure color logic.
- Never change a computed color without a role (`bg`, `fg`, `bd`, `sh`). See `roleOf` in `src/shared/transform.js`.
- Prefer rule-level fixes in `sheets.js` over per-element fixes in `layout.js`. Per-element fixes are slower and
  override `:hover`.
- Screenshots in the repo must come from the fixtures, never from third-party sites.
