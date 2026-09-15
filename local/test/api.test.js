import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { request } from 'node:http';
import { open } from '../src/db.js';
import { createApi } from '../src/http.js';

const TOKEN = 'magpie_local_test_token';
let db;
let server;
let port;

beforeAll(async () => {
  db = open(':memory:');
  server = createApi({ db, token: TOKEN, version: '0.0.0-test' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(() => server.close());

beforeEach(() => {
  db.exec('DELETE FROM pages; DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM vectors;');
});

/** node:http rather than fetch, so Host and Origin can be set exactly. */
function call(path, { method = 'GET', token = TOKEN, host = `127.0.0.1:${port}`, origin, body } = {}) {
  const headers = { host };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (body) headers['content-type'] = 'application/json';

  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, setHost: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const capture = (over = {}) => ({
  space_id: 'default',
  content: 'A summary of the chapter about storage engines.',
  full_text: 'LSM trees compact in the background. B-trees update pages in place.',
  metadata: { url: 'https://example.com/ddia', title: 'DDIA chapter 3', captured_at: '2026-09-15T00:00:00Z' },
  ...over,
});

describe('who is allowed in', () => {
  it('refuses a request with no token', async () => {
    const res = await call('/v1/spaces', { token: null });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('bad_token');
  });

  it('refuses the wrong token', async () => {
    expect((await call('/v1/spaces', { token: 'magpie_local_not_it' })).status).toBe(401);
  });

  it('refuses a request that did not arrive at the loopback name', async () => {
    // What DNS rebinding looks like from the server's side: the browser resolves
    // a hostile name to 127.0.0.1 and sends its own Host header along.
    const res = await call('/v1/spaces', { host: 'evil.example' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_loopback');
  });

  it('answers /health without a token, and says nothing about what is stored', async () => {
    const res = await call('/health', { token: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: 'magpie-local' });
    expect(Object.keys(res.body)).not.toContain('pages');
  });
});

describe('who is allowed to read the answer', () => {
  it('gives an extension the header it needs', async () => {
    const res = await call('/v1/spaces', { origin: 'chrome-extension://abcdefghijklmnop' });
    expect(res.headers['access-control-allow-origin']).toBe('chrome-extension://abcdefghijklmnop');
  });

  it('gives a web page nothing, even with a valid token', async () => {
    const res = await call('/v1/spaces', { origin: 'https://evil.example' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it("refuses a web page's preflight outright", async () => {
    const res = await call('/v1/record', { method: 'OPTIONS', origin: 'https://evil.example', token: null });
    expect(res.status).toBe(403);
  });

  it("allows an extension's preflight", async () => {
    const res = await call('/v1/record', { method: 'OPTIONS', origin: 'chrome-extension://abc', token: null });
    expect(res.status).toBe(204);
  });

  it('pins to one extension when one is named', async () => {
    const pinned = createApi({ db, token: TOKEN, allowedExtensionId: 'theRealOne' });
    await new Promise((r) => pinned.listen(0, '127.0.0.1', r));
    const otherPort = pinned.address().port;

    const ask = (origin) => new Promise((resolve) => {
      request({ host: '127.0.0.1', port: otherPort, path: '/v1/spaces',
        headers: { authorization: `Bearer ${TOKEN}`, origin } }, (res) => {
        res.resume();
        resolve(res.headers['access-control-allow-origin']);
      }).end();
    });

    expect(await ask('chrome-extension://theRealOne')).toBe('chrome-extension://theRealOne');
    expect(await ask('chrome-extension://someOtherExtension')).toBeUndefined();
    pinned.close();
  });
});

describe('the capture round trip', () => {
  it('stores a capture and finds it again by a word from the source', async () => {
    const stored = await call('/v1/record', { method: 'POST', body: capture() });
    expect(stored.status).toBe(201);
    expect(stored.body).toMatchObject({ space_id: 'default', status: 'stored' });

    const found = await call('/v1/search?q=compaction');
    expect(found.body.results[0]).toMatchObject({
      title: 'DDIA chapter 3',
      url: 'https://example.com/ddia',
      matched: ['keyword'],
    });
  });

  it('lists the spaces that have been written to, so the picker fills itself', async () => {
    await call('/v1/record', { method: 'POST', body: capture() });
    await call('/v1/record', { method: 'POST', body: capture({ space_id: 'work', metadata: { url: 'https://example.com/w' } }) });

    const res = await call('/v1/spaces');
    expect(res.body.spaces.map((s) => s.space_id)).toEqual(['default', 'work']);
  });

  it('reads one page back whole', async () => {
    const stored = await call('/v1/record', { method: 'POST', body: capture() });
    const page = await call(`/v1/pages/${stored.body.id}`);
    expect(page.body.summary).toBe('A summary of the chapter about storage engines.');
    expect(page.body.content).toContain('B-trees');
  });

  it('deletes a page, and stops finding it', async () => {
    const stored = await call('/v1/record', { method: 'POST', body: capture() });
    expect((await call(`/v1/pages/${stored.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call('/v1/search?q=compaction')).body.results).toHaveLength(0);
  });

  it('says what is wrong with a capture it cannot store', async () => {
    const res = await call('/v1/record', { method: 'POST', body: { content: 'no url anywhere' } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/url/);
  });

  it('answers recent captures newest first, without their bodies', async () => {
    await call('/v1/record', { method: 'POST', body: capture({ metadata: { url: 'https://example.com/1', captured_at: '2026-09-01T00:00:00Z' } }) });
    await call('/v1/record', { method: 'POST', body: capture({ metadata: { url: 'https://example.com/2', captured_at: '2026-09-14T00:00:00Z' } }) });

    const res = await call('/v1/recent?n=5');
    expect(res.body.pages.map((p) => p.url)).toEqual(['https://example.com/2', 'https://example.com/1']);
    expect(res.body.pages[0].content).toBeUndefined();
    expect(res.body.pages[0].chars).toBeGreaterThan(0);
  });

  it('has no route it does not mean to have', async () => {
    expect((await call('/v1/../etc/passwd')).status).toBe(404);
    expect((await call('/')).status).toBe(404);
  });
});
