# Local memory store

Status: proposed 2026-09-15. Not approved, not started. A fourth piece, larger
than the first three, because it ships a second program.

## The problem

magpie cannot do anything until you have an account somewhere else. Press
Remember on a fresh install and it asks for an API key from a service you have
not heard of. That is a signup wall in front of a tool whose entire pitch is
that your reading stays on your machine, and it is the reason the extension is
a utility rather than something people pass around.

It is also a gap in the product line. There is nowhere for a capture to go that
costs nothing and belongs to nobody, and there is no way to *read* anything back:
magpie writes to memory layers and never reads from them, so the pages you have
saved are only useful in whatever service you chose.

## The change

A local memory store: a small program on your own machine that magpie writes to
like any other provider, and that Claude reads from over MCP.

```
                     ┌──────────────────────────────────────┐
  magpie extension   │  magpie-local (one process)          │
        │            │                                      │
        └─ POST ─────▶  HTTP on 127.0.0.1                   │
                     │      │                               │
                     │      ▼                               │
                     │  ~/.magpie/memories.db  (SQLite)     │
                     │      ▲                               │
                     │      │                               │
  Claude Code ───────┼─ MCP ┘  search, get_page, recent     │
  Claude Desktop     └──────────────────────────────────────┘
```

Install, press Remember, it is saved. Point Claude at it and it can read what
you saved. No account, no key, no network.

## What this is not

The boundary is not which models are used. Every model worth using here is
public. The split is:

- **Retrieval** is commodity. Chunk, embed, search, fuse. It is in a dozen npm
  packages and withholding it makes the open half feel crippled while
  protecting nothing.
- **Memory** is the product. Extracting facts from raw text, consolidating them
  into observations, supersession, temporal reasoning, reflect and reason,
  scoping, sharing, multi-tenancy. None of that code comes near this repo.

Said in one line for the README: the local store answers *"find what I saved
about X"*, Anona Memory answers *"what do I know about X, what changed, and what
supersedes what"*. Someone who outgrows the first wants the second, and no
amount of local retrieval gets them there.

Two consequences that are decisions, not omissions: **no cross-encoder
reranker**, and **no generation**. On generation, see the MCP section: the
caller is already a model.

## Why a separate process

An MCP server is a process speaking stdio or streamable HTTP. Nothing can reach
into the extension's `IndexedDB` from Claude Code, so a store that lives only in
the extension can never be read by anything else, which is half the point.

The second reason decides where the embedding model lives: **queries arrive when
the browser is closed**. Claude asks the MCP server, not the extension, so the
query side has to be able to embed text on its own. The daemon owns the model.

The cost is honest: a second thing to install. magpie must keep working with no
daemon running, and the local provider must fail with "magpie-local is not
running" and the one command that starts it. Never a silent fallback to a cloud
provider, the same rule raw mode follows.

## HTTP surface

Deliberately the same shape as Anona's write API, so the extension adapter is
nearly a copy of `src/lib/providers/anona.js` and the existing space picker
works with no new UI at all.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/record` | store a capture |
| `GET` | `/v1/spaces` | list spaces, so the picker fills itself |
| `GET` | `/v1/search?q=&k=` | the query path, used by MCP and by anything else |
| `GET` | `/v1/pages/:id` | one page, full text |
| `GET` | `/health` | is it running, what version, how many memories |

`POST /v1/record` takes `{space_id, content, metadata, tags}`. `metadata`
carries `{url, title, captured_at, mode, source_kind}`, which is what
`captureMetadata` already sends.

A space here is a folder name, nothing more. It exists so the same capture flow
works against both kinds of destination without a branch in the extension.

## Storage

One SQLite file at `~/.magpie/memories.db`, mode 600.

```sql
CREATE TABLE pages (
  id           TEXT PRIMARY KEY,     -- uuid
  space        TEXT NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,                 -- what a cloud provider would have received
  content      TEXT NOT NULL,        -- the full text, which is the local advantage
  source_kind  TEXT NOT NULL,        -- page | pdf | selection | google-doc | ...
  captured_at  TEXT NOT NULL,
  note         TEXT
);
CREATE UNIQUE INDEX pages_space_url ON pages (space, url);

CREATE TABLE chunks (
  id        INTEGER PRIMARY KEY,
  page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL,
  text      TEXT NOT NULL
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content=chunks, content_rowid=id);

CREATE TABLE vectors (                -- populated in v1, declared in v0
  chunk_id  INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,            -- e.g. bge-small-en-v1.5
  dim       INTEGER NOT NULL,
  embedding BLOB NOT NULL             -- float32
);
```

Records, metadata, the text index and the vectors in **one file**. That is the
reason for SQLite over a dedicated vector store: hybrid search needs both halves
and a join, and splitting them means two round trips reconciled by hand in
application code on every query, which is where hybrid ranking goes wrong
quietly. One file is also one thing to back up, and `sqlite3` opens it on any
machine.

`model` and `dim` live on every vector row on purpose. Changing the embedding
model invalidates every vector, and without those columns the first upgrade
returns plausible nonsense instead of an error. Re-embedding is lazy and in the
background; rows whose `model` does not match the current one are skipped by
search until they are rewritten.

**Full text is kept, unlike a cloud write.** magpie sends summaries so nobody
pays to store and extract an entire article. On disk that constraint does not
exist, so the local store keeps the summary *and* the source, indexes chunks of
the source, and shows the summary as the headline. Better retrieval than the
paid path on that one axis, at no cost.

Chunking reuses `src/lib/chunk.js` as it stands: token-aware, splits on
structure. It is already the tested part of the extension and it moves across
unchanged.

## Search

**v0: FTS5 only.** `bm25()` ranking, snippets from `snippet()`, filters on space
and date. This is a genuinely good answer to "find that page about compaction"
and it needs no model, no download and no GPU.

**v1: hybrid.** The FTS5 result list and a vector result list, fused with
Reciprocal Rank Fusion. RRF is ten lines from a 2009 paper, not a trade secret,
and it is what makes keyword and semantic results into one list without tuning
a weight nobody can tune.

Vectors are `BLOB`s scanned exactly, in process. At the scale this product
actually reaches, 20 pages a day is about 70k chunks a year, which is ~107MB at
384 dimensions and 30 to 80ms for an exact scan. **Approximate search is
unnecessary for years**, and exact is a feature: no index to rebuild, no recall
cliff, no tuning. `sqlite-vec` goes in when a profile says the scan is the
bottleneck, and because it is a loadable extension that is an upgrade rather
than a migration.

If it ever outgrows that, the escape hatch is contained: SQLite stays the system
of record and only the `vectors` table moves to something like LanceDB. Decide
it against a real user with half a million chunks, not now.

## Embeddings

`bge-small-en-v1.5` through transformers.js on onnxruntime-node, CPU. Same
family the engine uses. About 130MB downloaded once, ~300MB resident, and a
3000-word page is roughly ten chunks in under a second.

CPU and not WebGPU, because the daemon must answer a query with the browser
shut. An optional fast path exists later: the extension already has WebGPU, so
it could embed at capture time and hand the vectors over, with the daemon's own
model as the fallback and for queries. Not v1.

## MCP

Three tools, read-only:

```
search(query, k=8, space?)  -> ranked chunks with page title, url, date, snippet
get_page(id | url)          -> the full text of one page
recent(n=20, space?)        -> what was saved lately
```

**There is no `ask` tool and no model in the server.** In an MCP setup the
generation half of RAG is the client: Claude is the thing doing the reasoning,
so the server's whole job is retrieval and augmentation. Putting an LLM inside a
retrieval server whose only caller is an LLM buys nothing and costs a second
runtime, a second download, and a GPU requirement that would break `npx`.

Read-only is also the security posture. A tool that can write is a tool a prompt
injection in a web page can aim at your notes.

## Security

The daemon holds the full text of everything you have read, which is a larger
prize than the summaries a cloud provider gets. Non-negotiable:

- **bind 127.0.0.1 only**, never `0.0.0.0`;
- **a token**, generated at first run, printed once, pasted into magpie's
  settings the way every other provider key is. Any page you visit can
  `fetch('http://127.0.0.1:7777')`, and without a token every site you open can
  read everything you have ever saved;
- **CORS pinned to the extension id**, not `*`;
- the database file is **not encrypted**, and the README says so plainly. Mode
  600, the same protection the browser profile beside it has. SQLCipher is
  available if that is ever insufficient, at the price of the native dependency
  the rest of this design avoids.

## The extension side

Small, because the provider interface already exists.

| File | Change |
|---|---|
| `src/lib/providers/local.js` | **new**: the adapter. `buildRequest`, `parseResponse`, `loadOptions` against `/v1/spaces`, a monogram mark. |
| `src/lib/providers/registry.js` | register it; add `http://127.0.0.1:7777/*` to `PROVIDER_ORIGINS`, which is what generates the manifest's host permissions. |
| `src/popup.js` | nothing structural. The field list, picker and key link come from the adapter. |

Its `keysUrl` points at the local setup instructions rather than a website.
Its failure message when nothing is listening names the command to start it.

## Packaging

`magpie-local`, its own npm package inside this repo, MIT like the extension.
One story, one README, one install page.

Run with `npx magpie-local`, or installed globally and registered with Claude by
`claude mcp add magpie -- npx magpie-local mcp`.

## Sequencing

**v0 is FTS5 only.** The genuinely risky parts of this project are
cross-platform packaging, the localhost security model and the MCP wiring, and
none of them are embeddings. Cosine similarity is the best-understood component
in the whole system. Letting a 130MB model download gate the first working
end-to-end path spends a week buying nothing.

The schema carries the `vectors` table from v0 so v1 adds rows rather than
migrating anyone.

- **v0**: daemon, SQLite, FTS5, the three MCP tools, the extension adapter, the
  token, the install path.
- **v1**: embeddings, hybrid RRF, lazy re-embedding on model change.
- **later, only if asked for**: `sqlite-vec`, the WebGPU capture-time fast path.

## Testing

Unit, on the parts that are pure:

- RRF fusion: two ranked lists in, one order out, ties stable;
- the search query builder: space filter, date filter, no SQL assembled from
  user text;
- the re-embedding rule: rows whose `model` differs are excluded from vector
  search and queued, never silently compared across models.

Against a real SQLite file:

- a capture round trips: `POST /v1/record`, then `GET /v1/search` finds it by a
  word that appears only in the body;
- re-capturing the same URL in the same space updates rather than duplicating;
- deleting a page cascades to its chunks, its FTS rows and its vectors.

End to end, which is where the real risks are:

- **no token, or a wrong one, is refused**, and a request with an `Origin` that
  is not the extension is refused. This is the test that matters most: it is the
  difference between a personal tool and a public API to your reading history;
- the extension captures a page with the daemon running and the row appears in
  the database;
- with the daemon stopped, the capture is **blocked with a message naming the
  command**, and is retried successfully once it is running, through the
  existing durable queue with no special casing;
- the MCP server answers `search` over stdio with the browser closed.

## Open questions

1. **`node:sqlite` or `better-sqlite3`.** If the built-in module carries FTS5
   and can load extensions, the daemon ships with no native dependency at all,
   which is the difference between `npx` working everywhere and maintaining
   prebuilds for mac, windows and linux across two architectures. Worth an hour
   before either is committed to.
2. **`sqlite-vec` prebuilt binaries** on all three platforms, under whichever
   driver wins. Only matters at v1, but it can invalidate choice 1.
3. **Is local the default for a new install?** Default-local means adoption and
   slower conversion; default-cloud is today's behaviour. The recommendation is
   neither: first run asks, with local listed first as "no account needed",
   because where your reading goes is the one thing magpie never decides for
   you. This is a business call and is deliberately left to the owner.
4. **Port.** A fixed port is simple and collides; a port file in `~/.magpie/`
   is one more thing for the extension to read. Probably fixed, with an
   override.

## Out of scope

Sync between machines, sharing, and anything multi-user: that is the paid
product and pretending otherwise here would be a bait.

Consolidation, observations, supersession, reason, and the cross-encoder
reranker: the engine, and it stays closed.

Generation of any kind in the daemon.

Encryption at rest, for v0.

Reading *from* cloud providers. magpie still only writes to those; the local
store is the only thing it can read back, which is exactly what makes it worth
having.
