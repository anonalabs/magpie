// Mem0 — https://docs.mem0.ai

export const mem0 = {
  id: 'mem0',
  label: 'Mem0',
  keyPlaceholder: 'm0-...',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'm0-...', required: true },
    { key: 'userId', label: 'User id', type: 'text', placeholder: 'you@example.com', required: true },
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
        metadata: { url: capture.url, title: capture.title, source: 'magpie', mode: capture.mode },
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
