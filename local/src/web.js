// A page for looking at what you saved.
//
// The CLI answers the same questions, and this exists because reading is not
// what a terminal is for: the store holds whole articles, and the thing you
// most want to do with a search result is read it.
//
// One file, no build, no dependency, no network. Everything a browser needs
// is in the string below, which matters more here than anywhere else in this
// package: a local store that cannot be looked at while the house wifi is down
// is not local.
//
// Security. The page itself is served unauthenticated, because it contains no
// data: every number and every line of text on it arrives from an API call the
// token guards. The token reaches the page through the URL *fragment*, which
// the browser never sends to a server and never writes to a log, and is moved
// straight into localStorage and stripped out of the address bar. A hostile web
// page cannot read localStorage for this origin, cannot read our responses
// (CORS headers go to extension origins only), and cannot read this HTML
// either. So the token is in exactly one place a browser will keep it, and the
// `ui` command is the only thing that puts it there.

const CSS = `
:root {
  color-scheme: light dark;
  --paper:#fff; --sheet:#f7f6f4; --sheet-2:#eeece8;
  --ink:#1a1816; --muted:#5d5853; --faint:#6f6a64;
  --line:#e6e3df; --line-strong:#cfcac4;
  --red:#e7413c; --red-text:#b02324; --red-tint:#fbecea; --on-red:#fff;
  --green:#2f7d4f;
  --body: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper:#141211; --sheet:#1c1917; --sheet-2:#262220;
    --ink:#f2efea; --muted:#b8b2a9; --faint:#928b82;
    --line:#2a2624; --line-strong:#3d3835;
    --red:#ff5a54; --red-text:#ff8079; --red-tint:rgba(231,65,60,.14); --on-red:#16110f;
    --green:#5fbd84;
  }
}
:root[data-theme="dark"] {
  --paper:#141211; --sheet:#1c1917; --sheet-2:#262220;
  --ink:#f2efea; --muted:#b8b2a9; --faint:#928b82;
  --line:#2a2624; --line-strong:#3d3835;
  --red:#ff5a54; --red-text:#ff8079; --red-tint:rgba(231,65,60,.14); --on-red:#16110f;
  --green:#5fbd84;
}

* { box-sizing: border-box; }
html, body { margin:0; padding:0; }
body {
  background: var(--paper); color: var(--ink);
  font: 15px/1.55 var(--body);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--red-text); }

.shell { max-width: 1100px; margin: 0 auto; padding: 0 16px 72px; }

header.top {
  display:flex; align-items:baseline; gap:12px; flex-wrap:wrap;
  padding: 26px 0 18px; border-bottom: 1px solid var(--line); margin-bottom: 22px;
}
.brand { font-weight:600; letter-spacing:-.01em; font-size:1.0625rem; }
.brand .dot { color: var(--red); }
.brand .suffix { color: var(--faint); font-weight:400; }
.top .ver { font-family: var(--mono); font-size:.75rem; color: var(--faint); }
.top .right { margin-left:auto; display:flex; align-items:center; gap:10px; }

.pill {
  font-family: var(--mono); font-size:.6875rem; letter-spacing:.06em; text-transform:uppercase;
  padding: 3px 8px; border-radius:999px; border:1px solid var(--line-strong); color: var(--muted);
}
.pill.live { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
.pill.down { color: var(--red-text); border-color: color-mix(in srgb, var(--red) 45%, transparent); }

button, input[type=search], input[type=text] {
  font: inherit; color: inherit;
}
.btn {
  background: var(--sheet); border:1px solid var(--line-strong); color: var(--ink);
  border-radius:7px; padding:6px 11px; cursor:pointer;
}
.btn:hover { background: var(--sheet-2); }
.btn.danger { color: var(--red-text); border-color: color-mix(in srgb, var(--red) 40%, var(--line-strong)); }
.btn.small { padding:3px 8px; font-size:.8125rem; }
:focus-visible { outline: 2px solid var(--red); outline-offset: 2px; }

/* search ------------------------------------------------------------------ */
.searchbar { display:flex; gap:10px; align-items:center; margin-bottom: 8px; }
.searchbar input {
  flex:1; min-width:0; background: var(--sheet); border:1px solid var(--line-strong);
  border-radius:9px; padding:11px 13px;
}
.searchbar input::placeholder { color: var(--faint); }
select {
  font: inherit; color: inherit; background: var(--sheet);
  border:1px solid var(--line-strong); border-radius:9px; padding:10px 9px;
}
.hint { color: var(--faint); font-size:.8125rem; min-height:1.3em; margin: 0 0 22px; }

/* overview ---------------------------------------------------------------- */
.grid { display:grid; gap:14px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom:22px; }
.stat { border:1px solid var(--line); border-radius:11px; padding:13px 15px; background: var(--sheet); }
.stat .n { font-size:1.6rem; line-height:1.1; letter-spacing:-.02em; font-variant-numeric: tabular-nums; }
.stat .k {
  font-family: var(--mono); font-size:.625rem; letter-spacing:.11em; text-transform:uppercase;
  color: var(--faint); margin-top:5px;
}
.stat .sub { color: var(--muted); font-size:.8125rem; margin-top:4px; }

.panel { border:1px solid var(--line); border-radius:11px; padding:15px 17px; margin-bottom:22px; }
.panel h2 {
  font-family: var(--mono); font-size:.625rem; letter-spacing:.11em; text-transform:uppercase;
  color: var(--faint); margin:0 0 11px; font-weight:400;
}
.cols { display:grid; gap:22px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }

.tally { display:flex; flex-wrap:wrap; gap:7px; }
.tally span {
  border:1px solid var(--line-strong); border-radius:999px; padding:3px 10px; font-size:.8125rem;
}
.tally b { font-variant-numeric: tabular-nums; font-weight:600; }

.spark { display:flex; align-items:flex-end; gap:3px; height:44px; }
.spark i {
  flex:1; min-width:3px; background: var(--red); border-radius:2px 2px 0 0;
  opacity:.85; display:block;
}
.spark i[data-zero] { background: var(--line-strong); opacity:1; }
.axis { display:flex; justify-content:space-between; color:var(--faint); font-size:.6875rem; margin-top:6px; }

.meter { height:7px; border-radius:999px; background: var(--sheet-2); overflow:hidden; }
.meter i { display:block; height:100%; background: var(--red); }

/* results ----------------------------------------------------------------- */
.list { display:flex; flex-direction:column; gap:10px; }
.card {
  border:1px solid var(--line); border-radius:11px; padding:13px 15px; background: var(--paper);
}
.card:hover { border-color: var(--line-strong); }
.card .t { font-weight:600; letter-spacing:-.005em; }
.card .t button {
  background:none; border:0; padding:0; text-align:left; cursor:pointer; font:inherit; color:inherit;
}
.card .t button:hover { color: var(--red-text); }
.card .meta {
  display:flex; flex-wrap:wrap; gap:9px; align-items:center;
  color: var(--faint); font-size:.75rem; margin-top:5px;
}
.card .meta .host { font-family: var(--mono); }
.card .snip { color: var(--muted); font-size:.875rem; margin-top:8px; }
.card .snip mark { background: var(--red-tint); color: var(--ink); border-radius:2px; padding:0 1px; }
.tag {
  font-family: var(--mono); font-size:.625rem; letter-spacing:.08em; text-transform:uppercase;
  border:1px solid var(--line-strong); border-radius:999px; padding:1px 7px; color: var(--muted);
}

.empty { color: var(--faint); padding: 26px 2px; }

/* reader ------------------------------------------------------------------ */
dialog.reader {
  width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 64px);
  border:1px solid var(--line-strong); border-radius:13px; padding:0;
  background: var(--paper); color: var(--ink);
}
dialog.reader::backdrop { background: rgba(0,0,0,.45); }
.reader .head {
  position: sticky; top:0; background: var(--paper); border-bottom:1px solid var(--line);
  padding: 15px 18px; display:flex; gap:12px; align-items:flex-start;
}
.reader .head h3 { margin:0; font-size:1.05rem; letter-spacing:-.01em; }
.reader .head .x { margin-left:auto; }
.reader .body { padding: 16px 18px 26px; }
.reader .summary {
  border-left:2px solid var(--red); padding:2px 0 2px 12px; margin:0 0 18px; color: var(--muted);
}
.reader pre {
  font: .8125rem/1.65 var(--mono); white-space: pre-wrap; word-break: break-word; margin:0;
}

/* token gate -------------------------------------------------------------- */
.gate { max-width: 520px; margin: 60px auto; }
.gate h1 { font-size:1.4rem; letter-spacing:-.02em; margin:0 0 10px; }
.gate p { color: var(--muted); }
.gate form { display:flex; gap:9px; margin-top:16px; }
.gate input {
  flex:1; min-width:0; font-family: var(--mono); font-size:.8125rem;
  background: var(--sheet); border:1px solid var(--line-strong); border-radius:9px; padding:10px 12px;
}
code {
  font-family: var(--mono); font-size:.8125rem;
  background: var(--sheet-2); border-radius:4px; padding:1px 5px;
}
@media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; } }
`;

const JS = String.raw`
const KEY = 'magpie-local.token';
const $ = (sel) => document.querySelector(sel);

// The fragment is how the CLI hands the token over: it never reaches a server
// and never lands in a log. Taken once, kept, and removed from the address bar
// so a screenshot of this window is not a screenshot of the credential.
(function claimToken() {
  const m = location.hash.match(/(?:^|[#&])t=([^&]+)/);
  if (!m) return;
  try { localStorage.setItem(KEY, decodeURIComponent(m[1])); } catch { /* private window */ }
  history.replaceState(null, '', location.pathname);
})();

let token = (() => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } })();

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { authorization: 'Bearer ' + token, ...(options.headers || {}) },
  });
  if (res.status === 401) { token = ''; gate('That token was refused.'); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message || res.statusText);
  return res.json();
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const num = (n) => Number(n ?? 0).toLocaleString();

function bytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB']; let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return (v < 10 && i > 0 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)) + ' ' + u[i];
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

const host = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };

// Only a web link is ever linked. Escaping stops a quote from breaking out of
// the attribute; it does nothing about a scheme, and the record API accepts any
// string as a URL, so a stored "javascript:" would otherwise be one click away
// from running in this page's origin -- the origin that holds the token.
const webLink = (url, text) => {
  let ok = false;
  try { ok = ['http:', 'https:'].includes(new URL(url).protocol); } catch { ok = false; }
  return ok
    ? '<a href="' + esc(url) + '" target="_blank" rel="noreferrer noopener">' + esc(text) + '</a>'
    : '';
};

// The server marks matches with [ ] because FTS5 snippets are plain text; they
// become <mark> only after escaping, so a page whose text contains a tag is
// still shown as text.
const snippet = (text) => esc(text).replace(/\[([^\]]*)\]/g, '<mark>$1</mark>');

// ----------------------------------------------------------------- the gate --

function gate(message) {
  $('#app').innerHTML =
    '<div class="gate">'
    + '<h1>This machine needs its token</h1>'
    + '<p>' + (message ? esc(message) + ' ' : '')
    + 'Run <code>magpie-local ui</code> and it opens this page with the token already in it, '
    + 'or paste it below. It is in <code>~/.magpie/token</code>.</p>'
    + '<form id="gate-form"><input id="gate-input" type="text" placeholder="magpie_local_…" '
    + 'autocomplete="off" spellcheck="false" aria-label="Token"><button class="btn" type="submit">Unlock</button></form>'
    + '</div>';
  $('#gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('#gate-input').value.trim();
    if (!value) return;
    token = value;
    try { localStorage.setItem(KEY, value); } catch { /* private window */ }
    boot();
  });
}

// --------------------------------------------------------------- the layout --

function layout() {
  $('#app').innerHTML =
    '<header class="top">'
    + '<span class="brand"><span class="dot">●</span> magpie<span class="suffix">-local</span></span>'
    + '<span class="ver" id="ver"></span>'
    + '<span class="right"><span class="pill" id="health">checking</span>'
    + '<button class="btn small" id="refresh">Refresh</button></span>'
    + '</header>'
    + '<div class="searchbar">'
    + '<input id="q" type="search" placeholder="Search everything you saved" autocomplete="off" '
    + 'spellcheck="false" aria-label="Search">'
    + '<select id="space" aria-label="Space"><option value="">every space</option></select>'
    + '</div>'
    + '<p class="hint" id="hint"></p>'
    + '<div id="overview"></div>'
    + '<div class="panel"><h2 id="list-title">Lately</h2><div class="list" id="list"></div></div>'
    + '<dialog class="reader" id="reader"></dialog>';

  $('#refresh').addEventListener('click', () => { overview(); run(); });
  $('#space').addEventListener('change', run);

  let timer;
  $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
}

// ------------------------------------------------------------------ sections --

async function health() {
  const el = $('#health');
  try {
    const h = await fetch('/health').then((r) => r.json());
    el.textContent = 'running';
    el.className = 'pill live';
    $('#ver').textContent = 'v' + h.version;
  } catch {
    el.textContent = 'not answering';
    el.className = 'pill down';
  }
}

async function overview() {
  const s = await api('/v1/overview');
  const done = s.chunks ? Math.round((s.vectors / s.chunks) * 100) : 100;
  const peak = Math.max(1, ...s.days.map((d) => d.n));

  $('#overview').innerHTML =
    '<div class="grid">'
    + stat(num(s.pages), 'pages', s.newest ? 'newest ' + ago(s.newest.captured_at) : 'nothing yet')
    + stat(num(s.chunks), 'passages', num(s.words) + ' words')
    + stat(done + '%', 'embedded', s.vectors === s.chunks
      ? 'all of it searchable semantically'
      : num(s.chunks - s.vectors) + ' to go')
    + stat(bytes(s.diskBytes), 'on disk', s.spaces.length + (s.spaces.length === 1 ? ' space' : ' spaces'))
    + '</div>'
    + '<div class="panel"><div class="cols">'
    + '<div><h2>Last 14 days</h2><div class="spark">'
    + s.days.map((d) => '<i style="height:' + Math.max(2, Math.round((d.n / peak) * 44)) + 'px"'
      + (d.n ? '' : ' data-zero') + ' title="' + d.day + ': ' + d.n + '"></i>').join('')
    + '</div><div class="axis"><span>' + s.days[0].day.slice(5) + '</span><span>'
    + s.days.at(-1).day.slice(5) + '</span></div></div>'
    + '<div><h2>Spaces</h2><div class="tally">'
    + (s.spaces.length
      ? s.spaces.map((x) => '<span>' + esc(x.space) + ' <b>' + num(x.pages) + '</b></span>').join('')
      : '<span class="empty" style="padding:0">none yet</span>')
    + '</div><h2 style="margin-top:16px">Kinds</h2><div class="tally">'
    + (s.kinds.length
      ? s.kinds.map((x) => '<span>' + esc(x.kind) + ' <b>' + num(x.pages) + '</b></span>').join('')
      : '<span class="empty" style="padding:0">none yet</span>')
    + '</div></div>'
    + '<div><h2>Embedding</h2><div class="meter"><i style="width:' + done + '%"></i></div>'
    + '<div class="axis"><span>' + num(s.vectors) + ' of ' + num(s.chunks) + '</span><span>'
    + esc(s.model.split('/').pop()) + '</span></div>'
    + (s.staleVectors
      ? '<p class="hint" style="margin:10px 0 0">' + num(s.staleVectors)
        + ' vectors were written by another model and are ignored. They are being redone.</p>'
      : '')
    + '</div>'
    + '</div></div>';

  const select = $('#space');
  const chosen = select.value;
  select.innerHTML = '<option value="">every space</option>'
    + s.spaces.map((x) => '<option value="' + esc(x.space) + '">' + esc(x.space) + '</option>').join('');
  select.value = chosen;
}

function stat(n, k, sub) {
  return '<div class="stat"><div class="n">' + n + '</div><div class="k">' + k + '</div>'
    + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>';
}

// One list, two sources: typing searches, an empty box shows what is newest.
// They render the same way because a result and a capture are the same thing
// seen from different directions.
async function run() {
  const q = $('#q').value.trim();
  const space = $('#space').value;
  const list = $('#list');
  $('#list-title').textContent = q ? 'Results' : 'Lately';

  try {
    if (q) {
      const { results } = await api('/v1/search?q=' + encodeURIComponent(q)
        + '&k=25' + (space ? '&space=' + encodeURIComponent(space) : ''));
      $('#hint').textContent = results.length
        ? results.length + ' passage' + (results.length === 1 ? '' : 's')
          + ', keyword and semantic results fused'
        : '';
      list.innerHTML = results.length
        ? results.map(card).join('')
        : '<p class="empty">Nothing matched. Semantic search needs the model, which downloads once '
          + 'in the background; keyword search works from the first second.</p>';
    } else {
      const { pages } = await api('/v1/recent?n=25' + (space ? '&space=' + encodeURIComponent(space) : ''));
      $('#hint').textContent = '';
      list.innerHTML = pages.length
        ? pages.map(card).join('')
        : '<p class="empty">Nothing saved yet. Press magpie’s button on a page and it lands here.</p>';
    }
  } catch (err) {
    if (err.message !== 'unauthorized') list.innerHTML = '<p class="empty">' + esc(err.message) + '</p>';
    return;
  }

  for (const el of document.querySelectorAll('[data-open]')) {
    el.addEventListener('click', () => reader(el.dataset.open));
  }
  for (const el of document.querySelectorAll('[data-forget]')) {
    el.addEventListener('click', () => forget(el.dataset.forget, el.dataset.title));
  }
}

function card(row) {
  const id = row.page_id ?? row.id;
  return '<article class="card">'
    + '<div class="t"><button data-open="' + esc(id) + '">' + esc(row.title || row.url) + '</button></div>'
    + '<div class="meta">'
    + '<span class="host">' + esc(host(row.url)) + '</span>'
    + '<span>' + ago(row.captured_at) + '</span>'
    + '<span class="tag">' + esc(row.space) + '</span>'
    + (row.source_kind && row.source_kind !== 'page' ? '<span class="tag">' + esc(row.source_kind) + '</span>' : '')
    + (row.matched ? row.matched.map((m) => '<span class="tag">' + esc(m) + '</span>').join('') : '')
    + webLink(row.url, 'open')
    + '</div>'
    + (row.snippet ? '<div class="snip">' + snippet(row.snippet) + '</div>' : '')
    + '</article>';
}

async function reader(id) {
  const page = await api('/v1/pages/' + encodeURIComponent(id));
  const dialog = $('#reader');
  dialog.innerHTML =
    '<div class="head"><div><h3>' + esc(page.title || page.url) + '</h3>'
    + '<div class="meta" style="display:flex;gap:9px;flex-wrap:wrap;color:var(--faint);font-size:.75rem;margin-top:5px">'
    + '<span class="host" style="font-family:var(--mono)">' + esc(host(page.url)) + '</span>'
    + '<span>' + ago(page.captured_at) + '</span>'
    + '<span class="tag">' + esc(page.space) + '</span>'
    + webLink(page.url, 'open the original')
    + '</div></div>'
    + '<span class="x" style="display:flex;gap:8px">'
    + '<button class="btn small danger" data-forget="' + esc(page.id) + '" data-title="'
    + esc(page.title || page.url) + '">Forget</button>'
    + '<button class="btn small" id="close">Close</button></span></div>'
    + '<div class="body">'
    + (page.summary ? '<p class="summary">' + esc(page.summary) + '</p>' : '')
    + '<pre>' + esc(page.content) + '</pre>'
    + '</div>';

  dialog.querySelector('#close').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-forget]').addEventListener('click', (e) => {
    forget(e.currentTarget.dataset.forget, e.currentTarget.dataset.title);
  });
  dialog.showModal();
}

async function forget(id, title) {
  if (!confirm('Forget "' + title + '"? The page itself is untouched; this removes what was saved.')) return;
  await api('/v1/pages/' + encodeURIComponent(id), { method: 'DELETE' });
  $('#reader').close();
  overview();
  run();
}

// ------------------------------------------------------------------- boot ---

async function boot() {
  if (!token) return gate('');
  layout();
  await health();
  try { await overview(); } catch { return; }
  await run();
  // The embedding backfill runs in the daemon, so the percentage moves on its
  // own. Polling it is the only thing on this page that repeats.
  setInterval(() => { overview().catch(() => {}); health(); }, 20_000);
}

boot();
`;

/**
 * The whole page, as one string.
 *
 * A function rather than a file on disk so there is nothing to resolve at
 * runtime: `npx`, a global install and a checkout all serve the same bytes, and
 * no path has to be computed from `import.meta` against a packed tarball.
 */
export function page({ version = '0.0.0' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>magpie-local</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<circle cx="16" cy="16" r="11" fill="#e7413c"/></svg>',
  )}">
<style>${CSS}</style>
</head>
<body>
<main class="shell" id="app"></main>
<script>${JS}</script>
<!-- magpie-local ${version} -->
</body>
</html>
`;
}

/**
 * The address to open, with the token in the fragment.
 *
 * The fragment and not a query string: a query string is sent to the server and
 * lands in every log and every referrer along the way, and a credential in a URL
 * that gets written down is a credential that leaks. Everything after the `#`
 * stays in the browser.
 */
export const uiUrl = (port, token) =>
  `http://127.0.0.1:${port}/#t=${encodeURIComponent(token)}`;

/**
 * How to ask this platform to open a URL, or null where we do not know.
 *
 * Null is a real answer: printing the address is a complete outcome, and
 * guessing at a command is how a tool ends up reporting that it opened
 * something it did not.
 */
export function opener(platform = process.platform) {
  if (platform === 'darwin') return { cmd: 'open', args: [] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', ''] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [] };
  return null;
}
