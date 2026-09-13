import { DEFAULT_PROVIDER_ID, PROVIDERS } from './providers/registry.js';
import { DEFAULT_MODEL_SIZE } from './models.js';

const KEY = 'settings';

export const DEFAULT_SETTINGS = {
  // 'distill' keeps the page on the machine and sends a summary.
  // 'raw' sends the extracted article text. Always chosen, never fallen back to.
  mode: 'distill',
  modelSize: DEFAULT_MODEL_SIZE,
  providerId: DEFAULT_PROVIDER_ID,
  providers: Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, p]) => [
      id,
      Object.fromEntries(p.fields.map((f) => [f.key, f.default ?? ''])),
    ]),
  ),
};

/**
 * API keys live in storage.local, never storage.sync, sync would replicate them
 * to the user's Google account, which is not where anyone expects to have put a
 * credential by installing a browser extension.
 */
export async function loadSettings() {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return mergeDefaults(stored);
}

export async function saveSettings(patch) {
  const next = mergeDefaults({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Config for whichever provider is currently selected. */
export function providerConfig(settings) {
  return settings.providers?.[settings.providerId] ?? {};
}

function mergeDefaults(stored) {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  merged.providers = { ...DEFAULT_SETTINGS.providers };
  for (const [id, cfg] of Object.entries(stored?.providers ?? {})) {
    if (DEFAULT_SETTINGS.providers[id]) merged.providers[id] = { ...DEFAULT_SETTINGS.providers[id], ...cfg };
  }
  return merged;
}
