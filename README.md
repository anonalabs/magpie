# magpie

Remember any page into your memory layer — distilled on your own machine.

You are reading something worth keeping. You press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>.
A model running on your own GPU reads the page and writes a few sentences, and
those few sentences go to your memory layer. The article itself never leaves the
machine.

Works with [Anona Memory](https://anonalabs.com), [Mem0](https://mem0.ai) and
[Supermemory](https://supermemory.ai).

## What actually leaves your computer

magpie has two modes and they differ on exactly this point. It says which one
you are in before you press the button, and it never switches for you.

| Mode | What is sent | Needs |
|---|---|---|
| **Distill** (default) | Only the summary a local model wrote — typically a few hundred characters | WebGPU, and a one-time model download (~1.1 GB) |
| **Send page text** | The full extracted article text. Your memory layer does its own extraction | nothing |

Nothing else is ever sent anywhere. There is no telemetry, no analytics, and no
magpie server — your API key goes from your browser to your memory layer and
nowhere else. Keys are kept in `chrome.storage.local`, deliberately not
`chrome.storage.sync`, which would replicate them to your Google account.

## Install

Not in the Chrome Web Store yet.

```bash
npm install
npm run vendor:wasm   # downloads the two model libraries (11 MB) into src/vendor
npm run build
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → pick `dist/`.

Open the popup, choose your memory layer, paste an API key. Check
`chrome://extensions/shortcuts` if the keyboard shortcut is not bound.

## How it works

```
Alt+Shift+M  or  the Remember button
      │
      ▼
service worker ──── injects Readability into the tab ──▶ {title, url, text}
      │
      ├── send-page-text mode ──▶ POST to your memory layer          (done)
      │
      └── distill mode ──▶ offscreen document
                             ├─ loads the model on WebGPU (once per session)
                             ├─ chunks the article, summarises each part,
                             │  folds the parts into one summary
                             └─ POST to your memory layer            (done)
```

Four things about that shape are load-bearing:

**The offscreen document, not the service worker, owns the job.** A service
worker dies after 30 seconds idle and is capped at 5 minutes per event, and a
long article takes longer than both. An offscreen document has no such timeout,
so it carries the work through to the write. This was measured before anything
was built — see [`spikes/phase0`](spikes/phase0).

**The popup is a viewer.** Every capture can be started from the keyboard with no
popup at all; the badge (`…` → `✓`) is the whole interface for that path. Open
the popup mid-capture and it attaches to what is already running.

**Everything is chunked.** Both models have a 4096-token context, so a normal
article does not fit in one pass. magpie splits on headings and paragraphs, never
mid-sentence, summarises each part, and folds the parts — repeatedly, if it has
to — until one summary remains.

**The model libraries are inside the extension.** WebLLM fetches its compiled
`.wasm` kernels from a CDN by default, and Chrome counts a remotely-fetched
`.wasm` as remotely-hosted code, which is a flat Web Store rejection. So they are
vendored, `model_lib` is rewritten to `chrome.runtime.getURL()`, and
`npm run check:remote` fails the build if a CDN code URL ever reappears. Model
*weights* are data and still stream from Hugging Face.

## Development

```bash
npm run verify      # build, remote-code gate, unit tests, end-to-end tests
npm run watch       # rebuild dist/ on change
npm test            # unit tests only (chunking, provider adapters)
npm run test:e2e    # drives a real Chrome; asserts the real request body
npm run spike       # re-runs the phase-0 architecture probes
```

`npm run test:e2e` points `api.anonalabs.com` at a local HTTPS server with
`--host-resolver-rules`, so the request under test is the one the extension would
really send — same fetch, same headers, same host permission. Nothing inside the
extension is stubbed.

### Adding a memory layer

One file in [`src/lib/providers/`](src/lib/providers/), exporting `fields`,
`buildRequest` and `parseResponse`, then add it to `registry.js`. The manifest's
`host_permissions` are generated from `PROVIDER_ORIGINS` in that file, so a new
provider cannot ship with an unreachable host.

Say honestly what happened: if the API accepts a write for asynchronous
processing, report it as accepted, not as stored. `parseResponse` returns
`state: 'queued'` for that, and the receipt says so.

## Known limits

- Chrome and Edge only. Firefox's MV3 and WebGPU support are not there.
- One page at a time, the page you are on. No selection capture, no queueing.
- magpie writes to memory layers. It does not read from them.
- The distill path needs WebGPU. On a machine without it, magpie says so and
  offers to send page text instead, rather than failing quietly.

## License

MIT. Bundles Mozilla's Readability, which is MPL-2.0.
