import { anona } from './anona.js';
import { local, ORIGIN as LOCAL_ORIGIN } from './local.js';
import { mem0 } from './mem0.js';
import { supermemory } from './supermemory.js';

export const PROVIDERS = { local, anona, mem0, supermemory };
export const DEFAULT_PROVIDER_ID = 'anona';

/**
 * Host patterns for manifest host_permissions. Kept beside the adapters so a new
 * provider cannot ship with an unreachable host: the build reads this list and
 * writes the manifest from it.
 */
export const PROVIDER_ORIGINS = [
  `${LOCAL_ORIGIN}/*`,
  'https://api.anonalabs.com/*',
  'https://api.mem0.ai/*',
  'https://api.supermemory.ai/*',
];

export function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) {
    // Almost always a stale load rather than a bad setting: a popup page is
    // re-read from disk every time it opens, while the service worker keeps
    // running old code and Chrome keeps the old manifest until the extension is
    // reloaded. So a new destination can be chosen in the popup and then be
    // unknown to the worker that has to write to it.
    const err = new Error(`This build of magpie has no destination called "${id}". `
      + 'Reload the extension at chrome://extensions, then try again.');
    err.code = 'unknown_provider';
    throw err;
  }
  return provider;
}

/**
 * The part of a provider's config that decides WHERE a capture lands: every
 * field except the credential. It is snapshotted onto the record at capture
 * time and wins over the live settings when the record is finally sent, so a
 * capture goes to the destination that was on screen when the reader pressed
 * Remember. Changing the space afterwards must not redirect work already
 * captured, and a retry hours later must not land somewhere else again.
 *
 * The key is deliberately NOT snapshotted: a rotated key has to reach a queued
 * record, and there is no reason to keep a second copy of a credential.
 */
export function routingConfig(providerId, config = {}) {
  return Object.fromEntries(
    getProvider(providerId).fields
      .filter((f) => f.type !== 'password')
      .map((f) => [f.key, config[f.key] ?? ''])
      .filter(([, value]) => value !== ''),
  );
}

/**
 * The config one send actually uses: the credential (and anything else) from
 * today's settings, overlaid with the destination this capture was made for.
 * A record written before snapshots existed has none, and follows the setting.
 */
export function sendConfig(providerId, settingsConfig = {}, record = {}) {
  return { ...settingsConfig, ...routingConfig(providerId, record.destinationConfig ?? {}) };
}

/** "Anona Memory \u00b7 my-space": what the reader is told, from what will be sent. */
export function destinationLabel(providerId, routing = {}) {
  const provider = getProvider(providerId);
  const where = provider.fields.find((f) => f.type !== 'password' && routing[f.key]);
  return where ? `${provider.label} \u00b7 ${routing[where.key]}` : provider.label;
}

/** Which required fields are blank. Empty array means ready to send. */
export function missingFields(provider, config = {}) {
  return provider.fields
    .filter((f) => f.required && !String(config[f.key] ?? '').trim())
    .map((f) => f.label);
}

/**
 * Send one capture to one provider.
 *
 * Runs in the service worker or the offscreen document, never a content script.
 * Both of those are extension contexts, which are exempt from CORS for hosts in
 * host_permissions; a content script is not, and Anona's ALLOWED_ORIGINS does
 * not include chrome-extension:// origins.
 */
/**
 * Ask a provider to list the real values for one of its fields, Anona's spaces,
 * today. Returns {ok:false, message} rather than throwing: a provider being
 * unreachable must never be able to block configuring the extension, since
 * typing the value by hand still works.
 */
export async function loadFieldOptions(providerId, fieldKey, config) {
  const field = getProvider(providerId).fields.find((f) => f.key === fieldKey);
  if (!field?.loadOptions) return { ok: false, message: 'Nothing to load for this field.' };
  try {
    return await field.loadOptions(config);
  } catch (err) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}

export async function push(providerId, capture, config) {
  const provider = getProvider(providerId);

  const missing = missingFields(provider, config);
  if (missing.length) {
    return { ok: false, code: 'not_configured', message: `${provider.label} needs: ${missing.join(', ')}.` };
  }

  // Checked here rather than at the API, which answers a 422 that reads as an
  // unexplained failure. Only reachable in raw mode: a distilled summary is a
  // few hundred characters and never comes near any of these ceilings.
  if (provider.maxContentChars && capture.content.length > provider.maxContentChars) {
    return {
      ok: false,
      code: 'content_too_long',
      message: `This page is too long to send whole: ${capture.content.length.toLocaleString()} characters, `
        + `and ${provider.label} accepts ${provider.maxContentChars.toLocaleString()}.`,
      recover: 'distill',
      provider: provider.id,
      providerLabel: provider.label,
    };
  }

  const req = provider.buildRequest(capture, config);

  let res;
  try {
    res = await fetch(req.url, {
      method: req.method ?? 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
    });
  } catch (err) {
    // No status at all: DNS, offline, TLS, or a blocked host permission. A
    // provider that is a program on this machine can say something better than
    // "could not reach", so it is asked first.
    const own = provider.describeTransportError?.(err);
    if (own) return { ...own, provider: provider.id, providerLabel: provider.label };
    return { ok: false, code: 'network', message: `Could not reach ${provider.label}. ${String(err.message ?? err)}` };
  }

  // Some error responses are HTML or empty; never let that throw over the top of
  // the real status.
  let payload = null;
  try { payload = await res.json(); } catch { /* leave null */ }

  const result = provider.parseResponse(res.status, payload);
  return { ...result, provider: provider.id, providerLabel: provider.label, status: res.status };
}
