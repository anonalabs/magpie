// The API magpie writes to, on 127.0.0.1.
//
// Shaped like Anona's write API on purpose: the extension adapter is nearly a
// copy of the cloud one and the existing space picker works with no new UI.
//
// Three things guard it, and all three are needed. A token, because any page
// you visit can reach 127.0.0.1 and a store holding the full text of everything
// you have read is otherwise a public API to your reading history. A Host check,
// because DNS rebinding turns "evil.example" into 127.0.0.1 and the browser
// will happily send the request. And CORS headers only for extension origins,
// so a page that does get a request through still cannot read the answer.

import { createServer } from 'node:http';
import { chunkText } from './chunk.js';
import { deletePage, getPage, recentPages, spaces, stats, upsertPage } from './db.js';
import { search } from './search.js';

const MAX_BODY = 8 * 1024 * 1024;
// Roughly 3000 characters a chunk, matching what the extension's summariser
// uses, so a page is cut the same way wherever the cutting happens.
const CHUNK_TOKENS = 700;

const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
};

const fail = (res, status, code, message, headers) =>
  json(res, status, { error: { code, message } }, headers);

/** Only an extension may read an answer. A web page gets no CORS headers at all. */
function corsFor(origin, allowedExtensionId) {
  if (!origin?.startsWith('chrome-extension://')) return null;
  if (allowedExtensionId && origin !== `chrome-extension://${allowedExtensionId}`) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

/** A request that did not arrive at the loopback name did not come from this machine. */
function hostIsLoopback(host) {
  const name = String(host ?? '').split(':')[0].toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1';
}

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const parts = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
    parts.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  req.on('error', reject);
});

export function createApi({ db, token, embed = null, allowedExtensionId = null, version = '0.1.0' }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const cors = corsFor(req.headers.origin, allowedExtensionId);

    if (req.method === 'OPTIONS') {
      res.writeHead(cors ? 204 : 403, cors ?? {});
      return res.end();
    }

    if (!hostIsLoopback(req.headers.host)) {
      return fail(res, 403, 'not_loopback', 'This server answers on 127.0.0.1 only.');
    }

    // Unauthenticated on purpose, and says nothing about what is stored: this is
    // how the extension tells "not running" from "running and refusing me".
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, name: 'magpie-local', version }, cors ?? {});
    }

    const offered = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (offered !== token) {
      return fail(res, 401, 'bad_token', 'Wrong or missing token. It is printed once at first run and lives in ~/.magpie/token.', cors ?? {});
    }

    try {
      if (req.method === 'GET' && url.pathname === '/v1/spaces') {
        return json(res, 200, { spaces: spaces(db), total: spaces(db).length }, cors ?? {});
      }

      if (req.method === 'GET' && url.pathname === '/v1/stats') {
        return json(res, 200, stats(db), cors ?? {});
      }

      if (req.method === 'GET' && url.pathname === '/v1/search') {
        const results = await search(db, url.searchParams.get('q') ?? '', {
          k: Math.min(Number(url.searchParams.get('k') ?? 8) || 8, 50),
          space: url.searchParams.get('space') || null,
          embed,
        });
        return json(res, 200, { results, total: results.length }, cors ?? {});
      }

      if (req.method === 'GET' && url.pathname === '/v1/recent') {
        const rows = recentPages(db, {
          limit: Math.min(Number(url.searchParams.get('n') ?? 20) || 20, 200),
          space: url.searchParams.get('space') || null,
        });
        return json(res, 200, { pages: rows.map(withoutContent), total: rows.length }, cors ?? {});
      }

      const pageMatch = url.pathname.match(/^\/v1\/pages\/([^/]+)$/);
      if (pageMatch && req.method === 'GET') {
        const page = getPage(db, decodeURIComponent(pageMatch[1]));
        if (!page) return fail(res, 404, 'not_found', 'No page with that id.', cors ?? {});
        return json(res, 200, page, cors ?? {});
      }

      if (pageMatch && req.method === 'DELETE') {
        deletePage(db, decodeURIComponent(pageMatch[1]));
        return json(res, 200, { ok: true }, cors ?? {});
      }

      if (req.method === 'POST' && url.pathname === '/v1/record') {
        return json(res, 201, record(db, JSON.parse(await readBody(req) || '{}')), cors ?? {});
      }

      return fail(res, 404, 'no_route', `No route for ${req.method} ${url.pathname}.`, cors ?? {});
    } catch (err) {
      return fail(res, 400, 'bad_request', String(err?.message ?? err), cors ?? {});
    }
  });
}

const withoutContent = ({ content, ...rest }) => ({ ...rest, chars: content?.length ?? 0 });

/**
 * A capture.
 *
 * `content` is what magpie would have sent a cloud provider, which in the
 * default mode is a summary. `full_text` is the source, which only the local
 * store asks for: on disk the reason to send a summary instead of an article
 * does not exist, so the source is kept and indexed while the summary stays as
 * the headline. Chunks come from the source when there is one.
 */
export function record(db, body) {
  const content = String(body.content ?? '').trim();
  if (!content) throw new Error('content is required');

  const metadata = body.metadata ?? {};
  const url = String(metadata.url ?? body.url ?? '').trim();
  if (!url) throw new Error('metadata.url is required');

  const source = String(body.full_text ?? '').trim();
  const indexed = source || content;

  const page = {
    space: String(body.space_id ?? 'default'),
    url,
    title: String(metadata.title ?? body.title ?? url).slice(0, 500),
    summary: source ? content : null,
    content: indexed,
    source_kind: String(metadata.source_kind ?? 'page'),
    captured_at: metadata.captured_at ?? new Date().toISOString(),
    note: body.note ?? metadata.note ?? null,
  };

  const chunks = chunkText(indexed, CHUNK_TOKENS);
  const { id, chunkIds } = upsertPage(db, page, chunks.length ? chunks : [indexed]);
  return { id, space_id: page.space, chunks: chunkIds.length, status: 'stored' };
}
