// Supermemory — https://supermemory.ai/docs

export const supermemory = {
  id: 'supermemory',
  label: 'Supermemory',
  keyPlaceholder: 'sm_...',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'sm_...', required: true },
    { key: 'containerTag', label: 'Container tag', type: 'text', placeholder: 'optional', required: false },
  ],

  buildRequest(capture, config) {
    const body = {
      content: `# ${capture.title}\n\n${capture.url}\n\n${capture.content}`,
      // Keyed on the page, so re-remembering a page updates that document
      // instead of piling up near-duplicates of the same article.
      customId: `magpie:${capture.url}`,
      metadata: { url: capture.url, title: capture.title, source: 'magpie', mode: capture.mode },
    };
    if (config.containerTag) body.containerTags = [config.containerTag];

    return {
      url: 'https://api.supermemory.ai/v3/documents',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body,
    };
  },

  parseResponse(status, payload) {
    if (status >= 200 && status < 300) {
      return { ok: true, id: payload?.id ?? null, state: payload?.status === 'done' ? 'stored' : 'queued' };
    }
    return {
      ok: false,
      code: `http_${status}`,
      message: payload?.error ?? payload?.message ?? `Supermemory returned HTTP ${status}.`,
    };
  },
};
