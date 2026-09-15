// magpie-local: https://github.com/anonalabs/magpie/tree/main/local
//
// The one destination that is not somebody's service. A small program on this
// machine holds the captures in a SQLite file, searches them, and lets Claude
// read them over MCP. Nothing leaves the machine and there is no account.
//
// It is an ordinary provider because the interface already fits: an origin, a
// token, a space, one POST. That is the whole reason the local store cost the
// extension a single file.

import { captureMetadata } from '../compose.js';

export const ORIGIN = 'http://127.0.0.1:7777';

export const local = {
  id: 'local',
  label: 'This machine',
  // Not a service's mark: a monogram, like the other two that have no asset we
  // are entitled to ship.
  mark: { monogram: 'L' },
  keyPlaceholder: 'magpie_local_...',
  // The "sign up" link is an install instruction, since there is nothing to
  // sign up to.
  home: 'https://github.com/anonalabs/magpie/tree/main/local',
  keysUrl: 'https://github.com/anonalabs/magpie/tree/main/local#install',
  // No ceiling: the limit that makes a cloud provider refuse a whole article is
  // a bill, and there is no bill here. The store keeps the source text and
  // indexes it, which is the point of having it.
  maxContentChars: null,

  fields: [
    {
      key: 'apiKey',
      label: 'Token',
      type: 'password',
      placeholder: 'magpie_local_...',
      required: true,
    },
    {
      key: 'spaceId',
      label: 'Space',
      type: 'text',
      placeholder: 'default',
      required: true,
      default: 'default',
      loadLabel: 'Load spaces',
      async loadOptions(config) {
        if (!config.apiKey) return { ok: false, message: 'Start magpie-local and paste its token first.' };

        let res;
        try {
          res = await fetch(`${ORIGIN}/v1/spaces`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
          });
        } catch {
          return { ok: false, message: notRunning };
        }

        let payload = null;
        try { payload = await res.json(); } catch { /* leave null */ }
        if (!res.ok) return { ok: false, message: payload?.error?.message ?? `magpie-local returned HTTP ${res.status}.` };

        return {
          ok: true,
          options: (payload?.spaces ?? []).map((space) => ({
            value: space.space_id,
            label: space.space_id,
            note: space.pages ? `${space.pages} page${space.pages === 1 ? '' : 's'}` : '',
          })),
        };
      },
    },
  ],

  buildRequest(capture, config) {
    return {
      url: `${ORIGIN}/v1/record`,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        space_id: config.spaceId || 'default',
        content: capture.content,
        // Only this provider is sent the source. A memory layer is billed on
        // what it extracts, so magpie sends a summary; a file on your own disk
        // is not, so the source is kept and indexed while the summary stays as
        // the headline. Absent in raw mode, where the content already is the
        // source, and absent for a selection, which is the whole of what was
        // selected.
        ...(capture.sourceText ? { full_text: capture.sourceText } : {}),
        metadata: captureMetadata(capture),
        tags: ['magpie'],
      },
    };
  },

  parseResponse(status, payload) {
    if (status >= 200 && status < 300) {
      return { ok: true, id: payload?.id ?? null, state: 'stored' };
    }
    if (status === 401) {
      return {
        ok: false,
        code: 'not_configured',
        message: 'magpie-local rejected that token. Run `magpie-local token` and paste what it prints.',
      };
    }
    const err = payload?.error;
    return { ok: false, code: err?.code ?? `http_${status}`, message: err?.message ?? `magpie-local returned HTTP ${status}.` };
  },

  // A refused connection is not a failure of the capture: the store is simply
  // not running. It is retryable, and the message says the one thing to do.
  describeTransportError() {
    return { ok: false, code: 'local_not_running', message: notRunning, retryable: true };
  },
};

const notRunning = 'magpie-local is not running. Start it with `npx magpie-local serve` and this will retry on its own.';
