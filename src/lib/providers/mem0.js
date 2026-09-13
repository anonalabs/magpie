// Mem0 — https://docs.mem0.ai

import { captureMetadata } from '../compose.js';

export const mem0 = {
  id: 'mem0',
  label: 'Mem0',
  // A monogram, deliberately — not Mem0's logo. Shipping a mark we do not have
  // and cannot verify would be passing off a drawing as somebody's brand, and
  // bundling a scraped one is a trademark decision that is not ours to take.
  // Drop the real asset here when there is one to drop.
  mark: { monogram: 'm' },

  keyPlaceholder: 'm0-...',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'm0-...', required: true },
    {
      key: 'userId',
      label: 'User id',
      type: 'text',
      placeholder: 'you@example.com',
      required: true,
      loadLabel: 'Load users',
      async loadOptions(config) {
        if (!config.apiKey) return { ok: false, message: 'Add your API key first.' };

        let res;
        try {
          res = await fetch('https://api.mem0.ai/v1/entities/', {
            headers: { Authorization: `Token ${config.apiKey}` },
          });
        } catch (err) {
          return { ok: false, message: `Could not reach Mem0. ${err.message ?? err}` };
        }

        let payload = null;
        try { payload = await res.json(); } catch { /* leave null */ }
        if (!res.ok) {
          return { ok: false, message: payload?.detail ?? payload?.message ?? describeStatus(res.status) };
        }

        // The endpoint is called "get users" but returns every entity kind —
        // agents, apps and runs as well — distinguished only by `type`. Offering
        // an agent as a user id would file your reading under a bot.
        return {
          ok: true,
          options: (payload?.results ?? [])
            .filter((entity) => entity.type === 'user')
            .map((entity) => ({
              // `name` is the user_id that was written; `id` is Mem0's own key.
              value: entity.name ?? entity.id,
              label: entity.name ?? entity.id,
              note: entity.total_memories ? `${entity.total_memories} memories` : '',
            })),
        };
      },
    },
  ],

  buildRequest(capture, config) {
    return {
      url: 'https://api.mem0.ai/v3/memories/add/',
      headers: {
        // "Token", not "Bearer". Mem0 answers a Bearer header with a 401 that
        // reads exactly like a bad key.
        Authorization: `Token ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        messages: [{ role: 'user', content: `${capture.title}\n${capture.url}\n\n${capture.content}` }],
        user_id: config.userId,
        metadata: captureMetadata(capture),
      },
    };
  },

  parseResponse(status, payload) {
    if (status >= 200 && status < 300) {
      // Extraction is asynchronous and answers with an event id, so this is
      // acceptance, not storage. The UI must not claim more than that.
      return { ok: true, id: payload?.event_id ?? payload?.id ?? null, state: 'queued' };
    }
    return {
      ok: false,
      code: `http_${status}`,
      message: payload?.detail ?? payload?.message ?? `Mem0 returned HTTP ${status}.`,
    };
  },
};

function describeStatus(status) {
  if (status === 401 || status === 403) return 'That API key was rejected.';
  if (status === 429) return 'Mem0 is rate limiting this key.';
  return `Mem0 returned HTTP ${status}.`;
}
