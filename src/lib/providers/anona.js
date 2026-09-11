// Anona Memory — https://api.anonalabs.com

import { captureMetadata } from '../compose.js';

export const anona = {
  id: 'anona',
  label: 'Anona Memory',
  keyPlaceholder: 'anona_live_...',
  // MAX_CONTENT_CHARS on the gateway's write models. Past this the API answers
  // 422 naming the field, which reads to a reader as "it just failed".
  maxContentChars: 100_000,
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'anona_live_...', required: true },
    {
      key: 'spaceId',
      label: 'Space',
      type: 'text',
      placeholder: 'default',
      required: true,
      default: 'default',
      loadLabel: 'Load spaces',
      // Typing a space id is legitimate — a record write creates the space if it
      // does not exist — but it also means a typo silently becomes a new, empty
      // space that looks like the real one. Listing the real ones makes the
      // common case a choice instead of a spelling test.
      async loadOptions(config) {
        if (!config.apiKey) return { ok: false, message: 'Add your API key first.' };

        let res;
        try {
          // No trailing slash: the gateway serves the slash-less collection
          // route directly, precisely so callers do not meet a 307.
          res = await fetch('https://api.anonalabs.com/v1/spaces', {
            headers: { Authorization: `Bearer ${config.apiKey}` },
          });
        } catch (err) {
          return { ok: false, message: `Could not reach Anona Memory. ${err.message ?? err}` };
        }

        let payload = null;
        try { payload = await res.json(); } catch { /* leave null */ }

        if (!res.ok) {
          return { ok: false, message: payload?.error?.message ?? describeStatus(res.status) };
        }

        return {
          ok: true,
          options: (payload?.spaces ?? []).map((space) => ({
            // qualified_id is set only when another org shared this space, and
            // addressing by it is always safe — where the caller also owns a
            // space of the same name, the bare form is refused as ambiguous.
            value: space.qualified_id ?? space.space_id,
            label: space.name || space.space_id,
            note: space.shared_by ? `shared by ${space.shared_by}` : '',
          })),
        };
      },
    },
  ],

  buildRequest(capture, config) {
    return {
      url: 'https://api.anonalabs.com/v1/record',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      // Anona's data-plane models are extra="forbid": an unrecognised key is a
      // 422, not a silent drop. So this object is exactly the documented fields
      // and nothing else — note "async", which is the alias, not the Python-side
      // field name "async_".
      body: {
        space_id: config.spaceId || 'default',
        content: capture.content,
        metadata: captureMetadata(capture),
        tags: ['magpie'],
        // Queued rather than synchronous: the synchronous path runs an
        // extraction model inline and occasionally 503s under burst, which
        // would surface as "Remember" failing on a page that was fine.
        async: true,
      },
    };
  },

  parseResponse(status, payload) {
    if (status >= 200 && status < 300) {
      return {
        ok: true,
        // Async writes answer with a job id; the memory id is not known yet.
        id: payload?.memory_id ?? payload?.job_id ?? null,
        state: payload?.memory_id ? 'stored' : 'queued',
      };
    }
    // Anona's envelope is {"error": {"code", "message"}} — not FastAPI's "detail".
    const err = payload?.error;
    return { ok: false, code: err?.code ?? `http_${status}`, message: err?.message ?? describeStatus(status) };
  },
};

function describeStatus(status) {
  if (status === 401 || status === 403) return 'That API key was rejected.';
  if (status === 402 || status === 429) return 'Out of credits, or rate limited.';
  if (status === 422) return 'Anona rejected the request body.';
  return `Anona returned HTTP ${status}.`;
}
