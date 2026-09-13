// Supermemory — https://supermemory.ai/docs

import { captureMetadata } from '../compose.js';

export const supermemory = {
  id: 'supermemory',
  label: 'Supermemory',
  // A monogram, deliberately — not Supermemory's logo. Shipping a mark we do not have
  // and cannot verify would be passing off a drawing as somebody's brand, and
  // bundling a scraped one is a trademark decision that is not ours to take.
  // Drop the real asset here when there is one to drop.
  mark: { monogram: 's' },

  keyPlaceholder: 'sm_...',
  fields: [
    { key: 'apiKey', label: 'API key', type: 'password', placeholder: 'sm_...', required: true },
    // Free text, and not a picker: Supermemory has no endpoint that enumerates
    // container tags. A tag is just a string that starts existing the moment it
    // is used, so there is nothing to list and typing one is how you make one.
    { key: 'containerTag', label: 'Container tag', type: 'text', placeholder: 'optional', required: false },
  ],

  buildRequest(capture, config) {
    const body = {
      content: `# ${capture.title}\n\n${capture.url}\n\n${capture.content}`,
      // Keyed on the page, so re-remembering a page updates that document
      // instead of piling up near-duplicates of the same article.
      customId: `magpie:${capture.url}`,
      metadata: captureMetadata(capture),
    };
    // Singular. The plural `containerTags` array is deprecated on v3 and is not
    // accepted at all on v4.
    if (config.containerTag) body.containerTag = config.containerTag;

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
