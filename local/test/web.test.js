import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { open, upsertPage } from '../src/db.js';
import { createApi } from '../src/http.js';
import { opener, page, uiUrl } from '../src/web.js';

const TOKEN = 'magpie_local_test_token';

let db;
let server;
let base;

beforeEach(async () => {
  db = open(':memory:');
  server = createApi({ db, token: TOKEN, version: '9.9.9' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

const get = (path, init = {}) => fetch(base + path, init);
const authed = (path) => get(path, { headers: { authorization: `Bearer ${TOKEN}` } });

describe('the address the CLI prints', () => {
  it('carries the token in the fragment, where no server sees it', () => {
    const url = uiUrl(7777, 'magpie_local_abc');
    expect(url).toBe('http://127.0.0.1:7777/#t=magpie_local_abc');

    // The whole point: nothing before the # mentions it, so it cannot reach a
    // log, a referrer, or the server's own request line.
    const [addressed] = url.split('#');
    expect(addressed).not.toContain('magpie_local_abc');
    expect(new URL(url).search).toBe('');
  });

  it('escapes a token so it cannot end the fragment early', () => {
    expect(uiUrl(7777, 'a&t=b')).toBe('http://127.0.0.1:7777/#t=a%26t%3Db');
  });

  it('knows how to open a browser, and says so rather than guessing', () => {
    expect(opener('darwin').cmd).toBe('open');
    expect(opener('linux').cmd).toBe('xdg-open');
    expect(opener('win32').cmd).toBe('cmd');
    expect(opener('aix')).toBeNull();
  });
});

describe('the page itself', () => {
  it('is served without a token, because it holds no data', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    // Nothing from the store, and above all not the credential that reads it.
    expect(html).not.toContain(TOKEN);
    expect(html).toContain('magpie-local 9.9.9');
  });

  it('answers on /ui as well, so a bookmark of either works', async () => {
    expect((await get('/ui')).status).toBe(200);
  });

  it('forbids fetching anything from anywhere', async () => {
    const csp = (await get('/')).headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    // The page must work with the network down, so it may not reach out: no
    // font host, no CDN, and nothing to connect to but this server.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("img-src data:");
  });

  it('needs no network at all: no external URL in the whole document', () => {
    const html = page({ version: '1.0.0' });
    const external = [...html.matchAll(/https?:\/\/[^\s"'<),]+/g)]
      .map((m) => m[0])
      .filter((url) => !url.startsWith('http://127.0.0.1')
        // Namespaces and link relations are identifiers, not fetches.
        && !url.startsWith('http://www.w3.org'));
    expect(external).toEqual([]);
  });

  it('escapes every value it draws, because a saved page is untrusted text', () => {
    const html = page();
    // Titles, URLs, spaces and snippets all pass through esc() or webLink();
    // the one place a raw substitution would be invisible is a template that
    // interpolates a row field straight into markup.
    expect(html).toContain('const esc =');
    expect(html).toMatch(/esc\(row\.title/);
    expect(html).toContain('webLink(row.url');
    // And a link is only ever drawn for a scheme a browser should follow.
    expect(html).toContain("['http:', 'https:']");
  });

  it('strips the token out of the address bar once it has it', () => {
    const html = page();
    expect(html).toContain('history.replaceState');
    expect(html).toContain('localStorage.setItem(KEY');
  });
});

describe('what the page reads', () => {
  const sample = (over = {}) => ({
    space: 'reading',
    url: 'https://example.com/storage',
    title: 'Storage engines',
    content: 'A long article about log structured merge trees and compaction.',
    summary: 'LSM trees compact in the background.',
    source_kind: 'page',
    captured_at: new Date().toISOString(),
    ...over,
  });

  it('refuses the overview without the token', async () => {
    const res = await get('/v1/overview');
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('bad_token');
  });

  it('answers the overview with everything the page draws', async () => {
    upsertPage(db, sample(), ['one chunk', 'two chunk']);

    const body = await (await authed('/v1/overview')).json();
    expect(body).toMatchObject({ pages: 1, chunks: 2, vectors: 0, withSummary: 1 });
    expect(body.days).toHaveLength(14);
    expect(body.spaces).toEqual([{ space: 'reading', pages: 1 }]);
    expect(body.newest.title).toBe('Storage engines');
    expect(typeof body.model).toBe('string');
  });

  it('leaves /v1/stats as the three counts the extension reads', async () => {
    upsertPage(db, sample(), ['a']);
    const body = await (await authed('/v1/stats')).json();
    // Widening this would put a fortnight of history on the response of every
    // capture; the page has its own route for that.
    expect(Object.keys(body).sort()).toEqual(['chunks', 'dim', 'model', 'pages', 'vectors']);
  });

  it('hands over one page in full, which is what the reader shows', async () => {
    const { id } = upsertPage(db, sample(), ['a']);
    const body = await (await authed(`/v1/pages/${encodeURIComponent(id)}`)).json();
    expect(body.content).toContain('compaction');
    expect(body.summary).toBe('LSM trees compact in the background.');
  });
});
