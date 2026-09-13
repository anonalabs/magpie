# Security

## Reporting a vulnerability

Please **do not open a public issue.** Write to
[support@anonalabs.com](mailto:support@anonalabs.com) with:

- what the issue is and what it lets an attacker do,
- the steps to reproduce it,
- the magpie version (`dist/manifest.json` → `version`) and your Chrome version.

You will get an acknowledgement within three working days, and an assessment with
a fix or a timeline within ten.

Please give us a reasonable window to release a fix before disclosing publicly.
Credit is given in the release notes unless you would rather not be named.

## What magpie holds

- **An API key** for your memory layer, in `chrome.storage.local`. Deliberately
  not `chrome.storage.sync`, which would replicate it to your Google account.
- **Captured page content**, on disk only while a write is pending or blocked. A
  landed capture keeps metadata and drops its content.
- **Model weights**, in the browser's cache.

Nothing is sent anywhere except the memory layer you configured. There is no
magpie server, no telemetry and no analytics.

## Things worth knowing

- The extension loads **no remote code**. Model libraries are vendored and
  `npm run check:remote` fails the build if a CDN-hosted `.wasm` or `.js` appears
  in `dist/`. Model *weights* are data and stream from Hugging Face.
- The in-page button is an **optional permission**, off by default, requested only
  when switched on.
- Content scripts are injected on demand for the page you ask to capture, not
  declared for every page you visit.

## Scope

In scope: anything that leaks a key or page content, escalates the extension's
permissions, or executes code from outside the package.

Out of scope: vulnerabilities in the memory layers themselves (report those to
their maintainers) and anything requiring physical access to an unlocked machine.
