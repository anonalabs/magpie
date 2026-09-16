# magpie-local

A local memory store for [magpie](https://github.com/anonalabs/magpie). Your
captures land in a SQLite file on your own machine, you can search them, and
Claude can read them over MCP.

No account, no key to obtain, no network. The pages you save never leave the
computer they were saved on.

```
  magpie extension ──POST──▶  127.0.0.1  ──▶  ~/.magpie/memories.db
                                   ▲
  Claude Code / Desktop ──MCP──────┘   search · get_page · recent
```

## Install

Node 22.5 or newer, which is the only requirement: the database is Node's own
`node:sqlite`, so there is nothing to compile and no platform-specific binary.

```bash
npm install -g magpie-local
magpie-local install        # runs it now, and from every login onwards
```

Or without installing anything permanent: `npx magpie-local start` runs it in
the background until you reboot, and `npx magpie-local serve` runs it in the
terminal where you can watch it.

It prints a token the first time. Paste that into magpie: **Settings → This
machine → Token**. It is in `~/.magpie/token` if you need it again, or run
`magpie-local token`.

Then let Claude read it:

```bash
claude mcp add magpie -- npx magpie-local mcp
```

## The commands

| | |
|---|---|
| `magpie-local` | what is in the store, and whether it is running |
| `magpie-local install` | start it now, and with the computer from now on |
| `magpie-local uninstall` | stop doing that |
| `magpie-local start` | run it in the background until the next reboot |
| `magpie-local stop` / `restart` | |
| `magpie-local serve` | run it here, in the foreground |
| `magpie-local search <query>` | search the store from the terminal |
| `magpie-local token` | print the token, for pasting into magpie |
| `magpie-local mcp` | speak MCP on stdio; Claude starts this itself |

`magpie-local` on its own is the one that answers everything: whether the
service is up and for how long, how much is stored, how much of it is embedded,
which spaces and what kinds of thing they came from, a fortnight of capture as a
sparkline, and the newest thing you saved.

It is read from your own file and printed on your own terminal. magpie has no
telemetry: none of it is sent anywhere, by that command or by anything else.

`start` writes a pid file and a log in `~/.magpie/`, and detaches, so closing
the terminal does not take the store with it. It does not survive a reboot.

`install` is the one that does. It writes your platform's own service file and
enables it, so the store is running whenever you are logged in:

| | |
|---|---|
| Linux | `~/.config/systemd/user/magpie-local.service`, enabled with `systemctl --user` |
| macOS | `~/Library/LaunchAgents/com.anonalabs.magpie-local.plist`, loaded with `launchctl` |
| Windows | a `.cmd` in the Startup folder |

It prints the file it wrote and the commands it ran, so nothing happens to your
machine that you cannot read first. `magpie-local uninstall` removes it. On
Linux it starts at login and stops at logout; `loginctl enable-linger $USER`
makes it run without you logged in at all.

`serve` and `mcp` are separate processes on purpose. Claude starts the MCP one
itself and owns its lifetime; `serve` runs while your browser does. They share
the file, which is what SQLite is for.

## What Claude gets

| Tool | For |
|---|---|
| `search_memories` | keyword and semantic search across everything you saved |
| `get_page` | the whole text of one page, by id or URL |
| `recent_memories` | what you saved lately |

All three are read-only. A tool that can write is a tool a prompt injection in a
web page can aim at your notes, and the writing surface already exists in the
extension behind a key you press.

There is deliberately no `ask` tool and no model inside the server. In an MCP
setup the generation half of retrieval-augmented generation is the client:
Claude is doing the reasoning, so this server's whole job is to find the right
text and hand it over.

## How search works

Two retrievers over the same file, fused with Reciprocal Rank Fusion:

- **FTS5** with the Porter stemmer, so "compaction" finds a page that says
  "compact", and each word you type is matched as a word rather than as query
  syntax;
- **vectors** from `bge-small-en-v1.5`, 384 dimensions, embedded on the CPU in
  this process.

The model is about 130MB and downloads once, in the background. **Nothing waits
for it**: captures are accepted and keyword search answers from the first
second, and semantic results start appearing on their own when the download
finishes. Every result says which retriever found it.

Vectors are scanned exactly rather than through an approximate index. At the
scale one person reaches, roughly 70k chunks a year, that is ~107MB and tens of
milliseconds, and exact means no index to rebuild and no recall cliff.

## What it stores

One row per page: the URL, the title, when you saved it, the summary magpie
wrote, and **the full source text**. The extension sends a summary to cloud
providers because they bill for what they extract; on your own disk there is no
bill, so the source is kept and indexed while the summary stays as the headline.

Re-saving a page replaces it rather than storing it twice.

```
~/.magpie/
  memories.db     pages, chunks, the text index and the vectors, one file
  token           the credential, mode 600
```

`magpie-local` says what is in it. `sqlite3 ~/.magpie/memories.db` opens
it, because it is an ordinary SQLite file and it is yours.

## Security

Any page you visit can make a request to `127.0.0.1`. A store holding the full
text of everything you have read is a bigger prize than one holding summaries,
so three things guard it:

- **a token** on every request except `/health`;
- **CORS headers only for extension origins**, so a web page that does get a
  request through still cannot read the answer;
- **a Host check**, because DNS rebinding turns a hostile name into 127.0.0.1
  and the browser sends the request anyway.

The database is **not encrypted**. Its directory is mode 700 and the token file
600, which is the same protection your browser profile has beside it. If that is
not enough for what you read, it should not be captured.

## Limits, deliberately

This is one machine. No sync, no sharing, no phone. It searches what you saved;
it does not consolidate facts, track what supersedes what, or reason across your
memories. That is [Anona Memory](https://memory.anonalabs.com), and it is a
different product that happens to also store text.

## Configuration

| Variable | Default |
|---|---|
| `MAGPIE_HOME` | `~/.magpie` |
| `MAGPIE_PORT` | `7777` |
| `MAGPIE_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` |

Changing the model invalidates every vector. Nothing breaks and nothing has to
be run: each vector records the model that wrote it, search ignores the ones
that do not match, and they are re-embedded in the background.

## Tests

```bash
npm test
```

The store, the search, the fusion and every guard above. They use `node:sqlite`
and the package's own source only, so they run without the embedding model
being present.

MIT.
