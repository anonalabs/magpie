// Anona Memory — https://api.anonalabs.com

export const anona = {
  id: 'anona',
  label: 'Anona Memory',
  keyPlaceholder: 'anona_live_...',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'anona_live_...', required: true },
    { key: 'spaceId', label: 'Space', type: 'text', placeholder: 'default', required: true, default: 'default' },
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
        metadata: {
          url: capture.url,
          title: capture.title,
          captured_at: capture.capturedAt,
          source: 'magpie',
          mode: capture.mode,
        },
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
