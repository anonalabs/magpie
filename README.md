# magpie

Remember any page into your memory layer — distilled on your own machine.

You are reading something worth keeping. You press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>.
A model running on your own GPU reads the page and writes a few sentences, and
those few sentences go to your memory layer. The article itself never leaves the
machine.

When you want to say why you kept it, press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>
instead. And to keep a passage rather than the page around it, select it and
right-click.

Works with [Anona Memory](https://anonalabs.com), [Mem0](https://mem0.ai) and
[Supermemory](https://supermemory.ai).

## What actually leaves your computer

Exactly one request, to the memory layer you configured. In distill mode:

```http
POST https://api.anonalabs.com/v1/record
Authorization: Bearer anona_live_…

{
  "space_id": "reading",
  "content": "The chapter compares storage engines built on log-structured merge
               trees against those built on B-trees. LSM-trees write sequentially
               and compact in the background; B-trees update pages in place.",
  "metadata": {
    "url": "https://example.com/ddia/ch3",
    "title": "Designing Data-Intensive Applications — Chapter 3",
    "captured_at": "2026-09-11T19:40:00.000Z",
    "source": "magpie",
    "mode": "distill"
  },
  "tags": ["magpie"],
  "async": true
}
```

`content` is the whole payload: in distill mode the summary the local model
wrote, in raw mode the extracted article text. The rest is the page's own
identity. Nothing else is collected and nothing else is sent.

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
the popup mid-capture and it attaches to what is already running. The same is
true of the optional in-page button.

**Nothing is lost.** A capture is written to disk before any network call, so an
unreachable provider, an expired key or an exhausted balance is a retry rather
than lost work. Retries back off and are scheduled with `chrome.alarms`, which
outlive the service worker. Failures that will never succeed — a rejected key, a
body the API refuses — stop immediately instead of hammering; they land in
**Needs you** in the history view with the reason. A landed capture drops its
content and keeps only metadata, so magpie can tell you it already saved a page
without keeping a second copy of everything you have read.

**A recovery is for one capture, not a setting.** "Send this page as text" sends
that page raw and leaves your mode alone. Raw is roughly **270x the content** at
the provider — 93,000 characters against 345 — and providers bill on what they
extract, so a one-click button in an error dialog must never be able to move
every future capture onto that path.

**Retries can duplicate, deliberately.** A write that times out or returns 5xx
may already have landed, so retrying it can create a second memory. magpie
retries anyway: losing a capture is worse than duplicating one, and a duplicate
is visible in history and in the revisit notice. Supermemory is unaffected, since
its `customId` updates in place. This is a decision, not an oversight — the
opposite call is defensible and is the one Anona's own email failover makes.

**Annotating is a second gesture, not a step.** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>
never prompts. <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> opens compose, which
starts the distill as it opens — so the note is written while the model runs, and
the waiting time becomes the typing time rather than being added to it. A
half-written note survives the popup closing, which it does on any click outside
it.

**A note goes into the content, not the metadata.** Memory layers extract from
content and largely ignore metadata, so a note stored there would be kept and
never found — worse than not offering one, because it looks like it worked. It is
mirrored into metadata for provenance only.

**A selection is stored verbatim.** You already chose those words; summarising
them into a shorter paraphrase discards the only thing the selection had. No
model, instant, and it works without WebGPU. The full selection is read from the
page rather than taken from the context-menu event, because Chrome truncates the
copy it puts there — measured at 92,962 characters read against a limit well
below it.

**Everything is chunked.** Both models have a 4096-token context. After reserving
150 tokens for the prompt, 350 for the answer and a little slack, an article gets
**3,500 tokens — about 14,000 characters — per call**, so a normal article does
not fit in one pass:

| | extracted | chunks | model calls |
|---|---|---|---|
| short post | 4,400 chars | 1 | 1 |
| long article | 27,500 chars | 2 | 3 |
| book chapter | 82,600 chars | 6 | 7 |

magpie splits on headings and paragraphs, never mid-sentence, summarises each
part in 2-3 sentences, then folds the parts into one 4-6 sentence summary —
repeating that fold if the parts are themselves too long to fit.

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

### Picking a value instead of typing it

A provider field can declare `loadOptions(config)` and the popup turns it into a
picker, filled automatically once a key is saved. Anona lists your spaces; Mem0
lists the users it already holds, filtered to `type === "user"` because the
endpoint named "get users" returns agents and runs too.

Supermemory deliberately has none: there is no endpoint that enumerates
container tags, because a tag is just a string that starts existing the moment
it is used. Typing stays possible everywhere for the same reason — an Anona
space is created by its first write, so a list must never become a cage.

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
- One page at a time, the page you are on.
- magpie writes to memory layers. It does not read from them.
- The floating in-page button is off by default. It needs a content script on
  every page, which is "read and change all your data on all websites" at
  install time, so it is an optional permission you turn on in settings rather
  than something the default install takes.
- The distill path needs WebGPU. On a machine without it, magpie says so and
  offers to send page text instead, rather than failing quietly.

## License

MIT. Bundles Mozilla's Readability, which is MPL-2.0.
