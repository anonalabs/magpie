# magpie

Remember any page into your memory layer — distilled on your own machine.

You are reading something worth keeping. You press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>.
A model running on your own GPU reads the page and writes a few sentences, and
those few sentences go to your memory layer. The article itself never leaves the
machine.

Works with [Anona Memory](https://anonalabs.com), [Mem0](https://mem0.ai) and
[Supermemory](https://supermemory.ai).

## Three gestures

| | |
|---|---|
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> | Remember this page. No prompt, no confirmation. |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> | Remember it **with a note** — why you kept it. |
| right-click a selection | Remember **that passage**, exactly as written. |

There is also a toolbar button, and an optional floating button on the page.

## What actually leaves your computer

Exactly one request, to the memory layer you configured:

```http
POST https://api.anonalabs.com/v1/record
Authorization: Bearer anona_live_…

{
  "space_id": "reading",
  "content": "The chapter compares storage engines built on log-structured
               merge trees against those built on B-trees…",
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

`content` is the whole payload. The rest is the page's own identity. There is no
telemetry, no analytics, and no magpie server — your API key goes from your
browser to your memory layer and nowhere else. Keys live in
`chrome.storage.local`, deliberately not `chrome.storage.sync`, which would
replicate them to your Google account.

### Two modes, and the difference is one field

| Mode | What is sent | Needs |
|---|---|---|
| **Distil** (default) | only the summary the local model wrote, ~350 characters | WebGPU, and a one-time model download |
| **Send page text** | the extracted article, ~93,000 characters on a long page | nothing |

That is roughly **270× the content** at the provider, and providers bill on what
they extract — so the two modes differ by about that much in cost too. All the
chunking and every model call happen locally and are free, so in distil mode a
long article costs the same at the provider as a short one.

A recovery button — *"Send this page as text"* — applies to that one capture and
never changes your setting. A one-click button in an error dialog must not be
able to make the expensive path permanent.

## Install

Not in the Chrome Web Store yet.

```bash
npm install
npm run vendor:wasm   # the two model libraries (11 MB) into src/vendor
npm run build
```

`chrome://extensions` → Developer mode → **Load unpacked** → pick `dist/`.

Open the popup, choose your memory layer, paste an API key. The space list fills
itself. Check `chrome://extensions/shortcuts` if a shortcut is not bound.

> After any change to permissions or commands you must **reload** the extension,
> not just rebuild. Chrome re-reads an unpacked extension's files on every load
> but caches its parsed manifest until reload — a rebuilt extension can run new
> code against the old manifest, and the symptoms look nothing like the cause.

## How it works

```
Alt+Shift+M  ·  Alt+Shift+N  ·  toolbar  ·  in-page button  ·  right-click a selection
      │
      ▼
service worker ──── is it a PDF? ──▶ offscreen: fetch and parse with pdf.js
      │                                        │
      ├── article ─▶ inject Readability ───────┤
      │                                        ▼
      │                              distil mode ─▶ chunk, summarise, fold
      │                              raw / selection ─▶ take the text as it is
      │                                        │
      └────────────── write to disk ◀──────────┘
                            │
                            ▼
                    send to your memory layer  (retry if it fails)
```

### The parts that are load-bearing

**The engine's lifecycle is its own tested module.** Loading, sharing,
discarding after a GPU fault, and queueing requests live in
[`src/lib/engine-pool.js`](src/lib/engine-pool.js) with `create` injected, so
they can be tested without a GPU. That code produced the same class of bug twice
— a handle used after the engine behind it was gone — and neither time was
catchable where it lived, because it only ran behind WebGPU. Three rules it
enforces: the engine is a promise rather than a variable that will be set soon;
teardown and rebuild are serialised, because unloading in parallel with a load
tears down the replacement; and a queued request resolves the engine when it
runs, never when it was queued.

**The offscreen document, not the service worker, owns the job.** A service
worker dies after 30 seconds idle and is capped at 5 minutes per event; a long
article takes longer than both. An offscreen document has no such timeout. This
was measured before anything was built — see [`spikes/phase0`](spikes/phase0).

**Nothing is lost.** A capture is written to disk *before* any network call, so an
unreachable provider, an expired key or an exhausted balance is a retry rather
than lost work. Retries back off 30s → 2m → 10m → 1h → 6h and are scheduled with
`chrome.alarms`, which outlive the worker. Failures that will never succeed — a
rejected key, a body the API refuses — stop immediately rather than hammering,
and land in **Needs you** with the reason.

A landed capture drops its content and keeps only metadata, so magpie can tell
you it already saved a page without keeping a second copy of everything you read.

Retrying a timeout or a 5xx *can* write twice, because such a failure may already
have landed. magpie retries anyway: losing a capture is worse than duplicating
one, and duplicates are visible in history. This is a decision, not an oversight;
the opposite call is defensible.

**Everything is chunked.** Both models have a 4096-token context. After reserving
150 tokens for the prompt, 350 for the answer and a little slack, an article gets
**3,500 tokens — about 14,000 characters — per call**:

| | extracted | chunks | model calls |
|---|---|---|---|
| short post | 4,400 chars | 1 | 1 |
| long article | 27,500 chars | 2 | 3 |
| book chapter | 82,600 chars | 6 | 7 |

Splits land on headings and paragraphs, never mid-sentence. Each part is
summarised in 2-3 sentences, then folded into one 4-6 sentence summary —
repeating that fold if the parts are themselves too long.

**Compression comes from the prompt, not from cleverness.** `max_tokens: 350` is a
hard ceiling per call, so a chunk collapses to roughly the same size whatever
went in. The stored result is flat — a 2,000-character post and a 200,000-character
document both land as a few hundred characters. This is lossy and one-way; the
page is the only backup.

**The popup is a viewer.** Every capture can be started from the keyboard with no
popup at all; the badge (`…` → `✓`) is the whole interface for that path. Open the
popup mid-capture and it attaches to what is already running.

**The model libraries are inside the extension.** WebLLM fetches its compiled
`.wasm` kernels from a CDN by default, and Chrome counts a remotely-fetched
`.wasm` as remotely-hosted code — a flat Web Store rejection. They are vendored,
`model_lib` is rewritten to `chrome.runtime.getURL()`, and `npm run check:remote`
fails the build if a CDN code URL reappears. Model *weights* are data and still
stream from Hugging Face, once.

## What it can read

**Articles** — via Mozilla's Readability, parsed from a clone so the page you are
looking at is not rearranged. A page that reduces to a sentence or two of
boilerplate is refused rather than stored, because such a memory is
indistinguishable from a real one on the way back out.

**PDFs** — Chrome renders them in a viewer no content script can enter, so magpie
fetches and parses the file itself with `pdf.js`. It reads up to **40 pages**; past
that it says so *in the content*, not only in metadata:

```
(Summarised from the first 40 of 312 pages.)
```

A caveat in metadata would be invisible exactly when it matters — when a summary
of chapter one is recalled as though it were the book. Three PDFs it will not
read, each named rather than collapsed into a generic failure: scanned ones (no
text layer — that needs OCR), `file://` ones (needs *Allow access to file URLs*),
and password-protected ones.

> magpie uses pdf.js's **legacy** build deliberately. The modern one calls
> `Uint8Array.prototype.toHex` without defining it — a method Chrome did not have
> until long after this extension's floor of 116.

**Selections** — stored exactly as selected. You already chose those words;
summarising them into a shorter paraphrase discards the only thing the selection
had. No model, instant, works without WebGPU. The full selection is read from the
page rather than taken from the context-menu event, because Chrome truncates the
copy it puts there.

## Notes, and editing

Annotating is a second gesture, not a step added to the first.
<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> opens compose, which **starts the
distil as it opens** — so the note is written while the model runs, and the
waiting time becomes the typing time rather than being added to it. The summary
arrives in an editable field when it is ready.

A note joins the **content**:

```
why I saved this

---

the summary
```

Not the metadata. Memory layers extract from content and largely ignore
metadata, so a note stored there would be kept and never found — worse than not
offering one, because it looks like it worked. It is mirrored into metadata for
provenance only.

A half-written note survives the popup closing, which it does on any click
outside it.

## History

A capture list grouped **Needs you**, **Waiting to send**, **Remembered**, each
row with retry, delete and the reason it failed. Revisiting a page you have
already remembered says when — it informs, it does not block, because
re-remembering a page that has changed is legitimate.

## The in-page button

Optional and off by default. A button on every page means a content script on
every page, which reads at install time as *"read and change all your data on all
websites"* — not a thing to take by default from people who installed this
because it keeps their reading on their own machine. Turn it on in settings and
Chrome asks then, in a tab (a popup cannot ask: Chrome closes it to show the
prompt, destroying the page awaiting the answer).

Shadow DOM, so no page's CSS can reach it and its own cannot leak. Draggable,
dismissable per site, top frame only.

## Memory layers

| | Endpoint | Auth | Notes |
|---|---|---|---|
| Anona Memory | `POST /v1/record` | `Bearer` | lists your spaces; content capped at 100,000 chars |
| Mem0 | `POST /v3/memories/add/` | `Token`, not Bearer | lists existing users; extraction is async |
| Supermemory | `POST /v3/documents` | `Bearer` | `customId` updates in place, so no duplicates |

### Adding one

One file in [`src/lib/providers/`](src/lib/providers/) exporting `fields`,
`buildRequest` and `parseResponse`, then add it to `registry.js`. The manifest's
`host_permissions` are generated from `PROVIDER_ORIGINS` there, so a new provider
cannot ship with an unreachable host.

A field can also declare `loadOptions(config)` and the popup turns it into a
picker. Anona lists spaces; Mem0 lists users, filtered to `type === "user"`
because the endpoint named "get users" returns agents and runs too. Supermemory
has none deliberately — nothing enumerates container tags, because a tag is a
string that starts existing when it is used. Typing stays possible everywhere for
the same reason: an Anona space is created by its first write, so a list must
never become a cage.

Say honestly what happened: if the API accepts a write for asynchronous
processing, report it as accepted, not stored.

## Development

```bash
npm run verify      # build, remote-code gate, unit tests, end-to-end tests
npm run watch       # rebuild dist/ on change
npm test            # 109 unit tests
npm run test:e2e    # 65 end-to-end, driving a real Chrome
npm run spike       # the phase-0 architecture probes
npm run package     # the Chrome Web Store zip
```

`test:e2e` points `api.anonalabs.com` at a local HTTPS server with
`--host-resolver-rules`, so the request under test is the one the extension would
really send — same fetch, same headers, same host permission. Nothing inside the
extension is stubbed. It generates a real PDF by hand rather than depending on a
library to test a library.

`npm run check:remote` has a positive control: it is verified to still fail on a
planted CDN `.wasm` before its passing result is trusted.

## Known limits

- Chrome and Edge only. Firefox's MV3 and WebGPU support are not there.
- One page at a time, the page you are on. No multi-tab queueing.
- magpie writes to memory layers. It does not read from them.
- Distilling needs WebGPU. Without it magpie says so and offers to send page
  text instead, rather than failing quietly.
- Scanned PDFs need OCR, which magpie does not do.
- WebGPU faults happen, particularly on integrated graphics under pressure —
  a lost device, or a buffer unmapped underneath a pending read. magpie treats
  any of them as meaning the engine is suspect: it throws the engine away and
  rebuilds it once, from the cached weights, rather than reusing one whose state
  it cannot trust. Reusing it turns a single fault into every later capture
  failing, which is the shape of bug this has produced twice.
- YouTube transcripts were considered and rejected: there is no public transcript
  API, and the workable route reads YouTube's internal player JSON out of the
  page — it works until YouTube changes shape, and no version of it does not.

## Publishing

`docs/publishing.md` — what the store listing needs, the permission
justifications, and the data disclosure. Two things are outstanding and neither
is code: a privacy policy at a public URL, and one screenshot.

## Design notes

Each piece was designed before it was built, and the reasoning is kept:

- [`docs/superpowers/specs/2026-09-11-durable-capture-design.md`](docs/superpowers/specs/2026-09-11-durable-capture-design.md)
- [`docs/superpowers/specs/2026-09-11-capture-time-control-design.md`](docs/superpowers/specs/2026-09-11-capture-time-control-design.md)
- [`docs/superpowers/specs/2026-09-11-pdf-capture-design.md`](docs/superpowers/specs/2026-09-11-pdf-capture-design.md)

## License

MIT. Bundles Mozilla's Readability (MPL-2.0) and Mozilla's pdf.js (Apache-2.0).
