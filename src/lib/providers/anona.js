// Anona Memory: https://api.anonalabs.com

import { captureMetadata } from '../compose.js';

export const anona = {
  id: 'anona',
  label: 'Anona Memory',
  // Anona's own origami-brain mark, from anonalabs/website.
  mark: { viewBox: '-11.4 14.7 533.5 483.5', svg: '<polygon points="463.18,110.35 167.22,222.23 134.86,312.21 188.93,375.46" fill="#e7413c"/>\n  <polygon points="132.99,25.53 -1.37,164.99 134.01,311.57" fill="#e7413c"/>\n  <polygon points="437.94,90.16 346.86,24.67 164.71,224.22" fill="#e7413c"/>\n  <polygon points="464.59,108.71 376.04,142.18 376.70,143.97 456.68,115.26 254.34,344.63 482.46,248.09 283.19,359.30 271.54,390.02 416.56,387.99 512.11,236.11" fill="#ce3430"/>\n  <polygon points="348.12,24.99 131.99,26.00 134.04,317.01 136.02,316.99 135.04,47.08 163.98,216.94 149.69,266.38" fill="#ce3430"/>\n  <polygon points="0.15,160.44 33.19,302.94 135.42,311.20" fill="#ce3430"/>\n  <polygon points="268.64,391.24 372.92,488.15 350.80,409.15" fill="#ce3430"/>\n  <polygon points="448.62,126.11 447.60,125.15 184.31,378.12 263.61,343.83" fill="#b02324"/>\n  <polygon points="136.13,28.98 133.98,310.68 165.03,226.11" fill="#b02324"/>\n  <polygon points="466.09,109.27 436.09,87.83 180.24,217.81 180.80,219.07" fill="#b02324"/>\n  <polygon points="503.68,237.95 503.09,236.75 302.26,322.23 282.70,362.44" fill="#b02324"/>\n  <polygon points="266.45,389.67 345.44,407.90 356.84,421.83 350.23,390.96 421.02,388.82 420.98,386.92 274.17,388.98 276.79,371.95" fill="#b02324"/>' },
  keyPlaceholder: 'anona_live_...',
  // Where a reader without an account goes. Naming the host in the link text
  // matters: a bare "get a key" in an extension popup is asking someone to
  // follow a link to a site it will not name.
  home: 'https://memory.anonalabs.com',
  keysUrl: 'https://memory.anonalabs.com/dashboard/keys',
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
      // Typing a space id is legitimate (a record write creates the space if it
      // does not exist), but it also means a typo silently becomes a new, empty
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
            // addressing by it is always safe, where the caller also owns a
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
      // and nothing else. Note "async", which is the alias, not the Python-side
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
    // Anona's envelope is {"error": {"code", "message"}}, not FastAPI's "detail".
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
