// The popup is a viewer. It can start a capture, but nothing depends on it
// staying open — closing it mid-job is normal, and reopening reattaches.

import { MSG, toBackground } from './lib/messages.js';
import { loadSettings, saveSettings, providerConfig } from './lib/settings.js';
import { PROVIDERS, getProvider, missingFields, loadFieldOptions } from './lib/providers/registry.js';
import { MODELS } from './lib/models.js';

const $ = (id) => document.getElementById(id);
const STATES = ['state-idle', 'state-working', 'state-done', 'state-error'];
const show = (id) => { for (const s of STATES) $(s).hidden = s !== id; };

let tabId = null;
let settings = null;

// ------------------------------------------------------------------ rail ----
function rail(mode, fraction = 0) {
  $('rail').hidden = mode === 'off';
  const fill = $('rail-fill');
  fill.classList.toggle('indeterminate', mode === 'indeterminate');
  if (mode === 'determinate') fill.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
  if (mode === 'indeterminate') fill.style.transform = '';
}

// -------------------------------------------------------------- rendering ---
function renderJob(job) {
  if (!job) { rail('off'); return show('state-idle'); }

  switch (job.state) {
    case 'starting':
    case 'loading':
    case 'summarising':
    case 'writing': {
      show('state-working');
      $('stage-name').textContent = job.stage ?? 'Working';

      // Two different progress meanings, and folding them into one percentage
      // would be a lie: a model download is a fraction of bytes, summarising is
      // a count of calls, and writing is neither.
      if (job.state === 'loading') {
        $('stage-count').textContent = `${Math.round((job.loadProgress ?? 0) * 100)}%`;
        rail('determinate', job.loadProgress ?? 0);
      } else if (job.totalSteps > 1) {
        $('stage-count').textContent = `${job.step ?? 0} of ${job.totalSteps}`;
        rail('determinate', (job.step ?? 0) / job.totalSteps);
      } else {
        $('stage-count').textContent = '';
        rail('indeterminate');
      }
      return;
    }

    case 'remembered': {
      rail('off');
      show('state-done');
      const label = job.result?.providerLabel ?? job.providerId;
      const queued = job.result?.state === 'queued';
      $('receipt-title').textContent = queued ? `Sent to ${label}` : `Remembered in ${label}`;
      // Say what actually happened: these APIs extract asynchronously, so the
      // write is accepted, not yet readable.
      $('receipt-detail').textContent = queued
        ? `${label} has it and is still processing. ${describeStored(job)}`
        : describeStored(job);
      $('receipt-summary').hidden = !job.summary;
      $('receipt-summary').textContent = job.summary ?? '';
      return;
    }

    case 'error':
    default: {
      rail('off');
      show('state-error');
      const result = job.result ?? {};
      $('error-detail').textContent = result.message ?? 'Something went wrong.';
      const recover = RECOVERIES[result.recover ?? result.code];
      $('recover').hidden = !recover;
      if (recover) {
        $('recover').replaceChildren(
          Object.assign(document.createElement('span'), { textContent: recover.label }),
        );
        $('recover').onclick = recover.run;
      }
    }
  }
}

const describeStored = (job) =>
  job.stored ? `Stored the ${job.stored.kind}, ${job.stored.chars.toLocaleString()} characters.` : '';

// Every failure with a way out offers it as a button, rather than naming the fix
// in prose and leaving the reader to go find the setting.
const RECOVERIES = {
  webgpu_unavailable: { label: 'Send the page text instead', run: async () => { await saveSettings({ mode: 'raw' }); start(); } },
  raw: { label: 'Send the page text instead', run: async () => { await saveSettings({ mode: 'raw' }); start(); } },
  smaller_model: { label: 'Use the smaller model', run: async () => { await saveSettings({ modelSize: 'small' }); start(); } },
  not_configured: { label: 'Open settings', run: () => openSettings(true) },
};

// ----------------------------------------------------------------- actions --
async function start() {
  show('state-working');
  $('stage-name').textContent = 'Reading the page';
  $('stage-count').textContent = '';
  rail('indeterminate');
  renderJob(await toBackground(MSG.START_CAPTURE, { tabId }));
}

function openSettings(open) {
  $('view-main').hidden = open;
  $('view-settings').hidden = !open;
  $('destination').classList.toggle('unset', !open && !isConfigured());
  $('destination-text').textContent = open ? 'Done' : destinationLabel();
}

const isConfigured = () =>
  missingFields(getProvider(settings.providerId), providerConfig(settings)).length === 0;

// The header always says where a capture would go. It is the one fact worth
// knowing before pressing, and it doubles as the way into settings.
function destinationLabel() {
  const provider = getProvider(settings.providerId);
  if (!isConfigured()) return 'Not set up';
  const space = providerConfig(settings).spaceId;
  return space ? `${provider.label} · ${space}` : provider.label;
}

// ---------------------------------------------------------------- settings --
// Options a provider listed for one of its fields, keyed "provider:field".
// Cached in storage.session so reopening the popup does not refetch.
const optionCache = {};
// Fields the reader chose to type by hand, even though a list is available.
const typingByHand = new Set();
// Not a value, an affordance. Namespaced so it cannot collide with a space id.
const OTHER = '__magpie_type_a_name__';

const cacheKey = (providerId, fieldKey) => `${providerId}:${fieldKey}`;

function renderProviderFields() {
  const provider = getProvider($('provider').value);
  const saved = settings.providers?.[provider.id] ?? {};
  $('provider-fields').replaceChildren(
    ...provider.fields.map((f) => buildField(provider, f, saved[f.key] ?? f.default ?? '')),
  );
  autoLoad(provider);
}

function buildField(provider, field, value) {
  const wrap = document.createElement('label');
  wrap.className = 'field';

  const caption = document.createElement('span');
  caption.className = 'field-label';
  caption.textContent = field.required ? field.label : `${field.label} (optional)`;

  const row = document.createElement('div');
  row.className = 'field-row';
  row.append(buildControl(provider, field, value));

  if (field.loadOptions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'load';
    button.textContent = field.loadLabel ?? 'Load';
    button.onclick = () => loadOptions(provider, field, button);
    row.append(button);
  }

  const note = document.createElement('small');
  note.className = 'field-note';
  note.id = `note-${field.key}`;

  wrap.append(caption, row, note);
  return wrap;
}

function buildControl(provider, field, value) {
  const options = optionCache[cacheKey(provider.id, field.key)];

  if (!options?.length || typingByHand.has(field.key)) {
    const input = document.createElement('input');
    input.type = field.type;
    input.id = `field-${field.key}`;
    input.placeholder = field.placeholder ?? '';
    input.value = value;
    return input;
  }

  const select = document.createElement('select');
  select.id = `field-${field.key}`;
  const known = options.some((o) => o.value === value);

  for (const option of options) {
    select.append(new Option(option.note ? `${option.label} — ${option.note}` : option.label,
      option.value, false, option.value === value));
  }

  // A value that is saved but not in the list still has to be selectable, or
  // opening settings and pressing Save would quietly replace it with nothing.
  // It is a real setting: the space is created by the first write.
  if (!known && value) select.append(new Option(`${value} — will be created`, value, false, true));

  // And a name that does not exist yet must stay typeable, or the list becomes a
  // cage around an API that is happy to create one.
  select.append(new Option('Type a different name…', OTHER, false, !known && !value));

  select.onchange = () => {
    if (select.value !== OTHER) return;
    typingByHand.add(field.key);
    replaceControl(provider, field, '');
  };
  return select;
}

function replaceControl(provider, field, value) {
  const control = buildControl(provider, field, value);
  $(`field-${field.key}`).replaceWith(control);
  control.focus?.();
}

async function loadOptions(provider, field, button, { quiet = false } = {}) {
  const note = $(`note-${field.key}`);
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Loading…'; }
  if (note && !quiet) { note.textContent = ''; note.classList.remove('bad'); }

  const result = await loadFieldOptions(provider.id, field.key, currentConfig(provider));

  if (button) { button.disabled = false; button.textContent = original; }

  if (!result.ok) {
    // A failed automatic attempt leaves the text box it was trying to improve,
    // and the button is still there to retry deliberately — so it stays quiet.
    // A failure that was actually asked for is reported.
    if (note && !quiet) { note.textContent = result.message; note.classList.add('bad'); }
    return result;
  }

  optionCache[cacheKey(provider.id, field.key)] = result.options;
  chrome.storage.session.set({ [`options:${cacheKey(provider.id, field.key)}`]: result.options }).catch(() => {});
  typingByHand.delete(field.key);
  replaceControl(provider, field, fieldValue(field.key));

  if (note) {
    note.classList.remove('bad');
    note.textContent = result.options.length
      ? `${result.options.length} space${result.options.length === 1 ? '' : 's'}.`
      : 'No spaces yet — type a name and it is created the first time you remember something.';
  }
  return result;
}

// Fill the list on open when a key is already saved, so the common case needs no
// button press at all.
async function autoLoad(provider) {
  for (const field of provider.fields) {
    if (!field.loadOptions) continue;
    const key = cacheKey(provider.id, field.key);
    if (optionCache[key]) continue;

    const cached = (await chrome.storage.session.get(`options:${key}`))[`options:${key}`];
    if (cached?.length) {
      optionCache[key] = cached;
      replaceControl(provider, field, fieldValue(field.key));
      continue;
    }

    if (!(settings.providers?.[provider.id] ?? {}).apiKey) continue;
    await loadOptions(provider, field, $('provider-fields').querySelector('button.load'), { quiet: true });
  }
}

const fieldValue = (key) => {
  const value = $(`field-${key}`)?.value ?? '';
  return value === OTHER ? '' : value.trim();
};

const currentConfig = (provider) =>
  Object.fromEntries(provider.fields.map((f) => [f.key, fieldValue(f.key)]));

const MODE_NOTES = {
  distill: 'A model on this machine writes the summary. The page text never leaves.',
  raw: 'The whole article text is sent, and your memory layer extracts from it.',
};

function renderModeNote() {
  const mode = document.querySelector('input[name=mode]:checked')?.value ?? 'distill';
  $('mode-note').textContent = MODE_NOTES[mode];
  $('model-field').hidden = mode !== 'distill';
}

const renderModelNote = () => { $('model-note').textContent = MODELS[$('model-size').value]?.note ?? ''; };

function renderSettings() {
  $(`mode-${settings.mode}`).checked = true;

  // Label only: the note does not fit inside a 360px select and truncates.
  $('model-size').replaceChildren(...Object.entries(MODELS).map(([size, model]) =>
    new Option(model.label, size, false, size === settings.modelSize)));

  $('provider').replaceChildren(...Object.values(PROVIDERS).map((p) =>
    new Option(p.label, p.id, false, p.id === settings.providerId)));

  renderModeNote();
  renderModelNote();
  renderProviderFields();
}

async function save() {
  const providerId = $('provider').value;
  const provider = getProvider(providerId);
  const config = currentConfig(provider);

  settings = await saveSettings({
    mode: document.querySelector('input[name=mode]:checked').value,
    modelSize: $('model-size').value,
    providerId,
    providers: { ...settings.providers, [providerId]: config },
  });

  const missing = missingFields(provider, config);
  $('save-note').textContent = missing.length
    ? `Saved. ${provider.label} still needs ${missing.join(' and ').toLowerCase()}.`
    : 'Saved.';
  renderIdle();
}

// --------------------------------------------------------- in-page button ---
// Behind an optional permission. A button on every page means a content script
// on every page, which reads at install time as "read and change all your data
// on all websites" — not a thing to take by default from people who installed
// this because it keeps their reading on their own machine.
const ALL_SITES = { origins: ['<all_urls>'] };

async function renderInPageToggle() {
  const granted = await chrome.permissions.contains(ALL_SITES);
  $('inpage').checked = granted;
  $('inpage-note').textContent = granted
    ? 'A magpie button sits in the corner of every page. Drag it to move it.'
    : 'Needs permission to run on the pages you visit. Without it, use the toolbar or the shortcut.';
}

async function toggleInPage(event) {
  const wanted = event.target.checked;
  // Chrome grants this only from a user gesture, which is why it is requested
  // here and not from the service worker.
  const granted = wanted
    ? await chrome.permissions.request(ALL_SITES)
    : !(await chrome.permissions.remove(ALL_SITES));
  if (wanted && !granted) event.target.checked = false;
  await toBackground(MSG.SYNC_IN_PAGE);
  renderInPageToggle();
}

// -------------------------------------------------------------------- idle --
function renderIdle() {
  const provider = getProvider(settings.providerId);
  const missing = missingFields(provider, providerConfig(settings));

  $('destination-text').textContent = destinationLabel();
  $('destination').classList.toggle('unset', missing.length > 0);

  $('remember').disabled = missing.length > 0;
  $('idle-hint').textContent = missing.length
    ? `Add your ${provider.label} ${missing.join(' and ').toLowerCase()} to start.`
    : MODE_NOTES[settings.mode];
}

// The shortcut is the primary way in, so the popup shows the one really bound —
// Chrome silently declines a suggested key it has already reserved.
async function renderShortcut() {
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((c) => c.name === 'remember-page')?.shortcut;
  const hint = $('shortcut-hint');
  if (!shortcut) { hint.hidden = true; return; }
  hint.textContent = shortcut.replace(/\+/g, ' ');
}

// -------------------------------------------------------------------- boot --
(async function boot() {
  settings = await loadSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  $('page-title').textContent = tab?.title ?? 'This page';
  $('page-url').textContent = (() => {
    try { return new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return tab?.url ?? ''; }
  })();

  renderSettings();
  renderIdle();
  renderShortcut();
  renderInPageToggle();

  $('remember').onclick = start;
  $('retry').onclick = start;
  $('again').onclick = start;
  $('save').onclick = save;
  $('provider').onchange = renderProviderFields;
  $('model-size').onchange = renderModelNote;
  $('inpage').onchange = toggleInPage;
  $('destination').onclick = () => openSettings($('view-settings').hidden);
  for (const el of document.querySelectorAll('input[name=mode]')) el.onchange = renderModeNote;

  // Reattach to whatever is already running for this tab.
  if (tabId != null) renderJob(await toBackground(MSG.GET_CAPTURE_STATE, { tabId }));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'JOB_UPDATE' && msg.job?.tabId === tabId) renderJob(msg.job);
    return false;
  });
})();
