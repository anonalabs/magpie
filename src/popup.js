// The popup is a viewer. It can start a capture, but nothing depends on it
// staying open — closing it mid-job is normal, and reopening reattaches.

import { MSG, toBackground } from './lib/messages.js';
import { loadSettings, saveSettings, providerConfig } from './lib/settings.js';
import { PROVIDERS, getProvider, missingFields } from './lib/providers/registry.js';
import { MODELS } from './lib/models.js';

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const section of ['state-idle', 'state-working', 'state-done', 'state-error']) {
    $(section).hidden = section !== id;
  }
};

let tabId = null;
let settings = null;

// --------------------------------------------------------------- rendering ---
function renderJob(job) {
  if (!job) return show('state-idle');

  switch (job.state) {
    case 'starting':
    case 'loading':
    case 'summarising':
    case 'writing': {
      show('state-working');
      $('stage-name').textContent = job.stage ?? 'Working';
      // Two different progress meanings: a model download is a fraction, and
      // summarising is a step count. Never mix them into one fake percentage.
      if (job.state === 'loading') {
        $('stage-count').textContent = `${Math.round((job.loadProgress ?? 0) * 100)}%`;
        $('bar-fill').style.width = `${Math.round((job.loadProgress ?? 0) * 100)}%`;
      } else if (job.totalSteps > 1) {
        $('stage-count').textContent = `${job.step ?? 0} / ${job.totalSteps}`;
        $('bar-fill').style.width = `${Math.round(((job.step ?? 0) / job.totalSteps) * 100)}%`;
      } else {
        $('stage-count').textContent = '';
        $('bar-fill').style.width = '40%';
      }
      return;
    }

    case 'remembered': {
      show('state-done');
      const label = job.result?.providerLabel ?? job.providerId;
      const queued = job.result?.state === 'queued';
      $('receipt-title').textContent = queued ? `Sent to ${label}` : `Remembered in ${label}`;
      $('receipt-detail').textContent = queued
        // Say what actually happened: these APIs extract asynchronously, so the
        // write is accepted, not yet readable.
        ? `${label} accepted it and is still processing. ${describeStored(job)}`
        : describeStored(job);
      $('receipt-summary').hidden = !job.summary;
      $('receipt-summary').textContent = job.summary ?? '';
      return;
    }

    case 'error':
    default: {
      show('state-error');
      const result = job.result ?? {};
      $('error-detail').textContent = result.message ?? 'Something went wrong.';
      const recover = RECOVERIES[result.recover ?? result.code];
      $('recover').hidden = !recover;
      if (recover) {
        $('recover').textContent = recover.label;
        $('recover').onclick = () => recover.run();
      }
    }
  }
}

const describeStored = (job) =>
  job.stored ? `Stored the ${job.stored.kind} (${job.stored.chars.toLocaleString()} characters).` : '';

// Every failure that has a way out offers it as a button, rather than describing
// the fix in prose and leaving the user to find the setting.
const RECOVERIES = {
  webgpu_unavailable: {
    label: 'Switch to sending page text',
    run: async () => { await saveSettings({ mode: 'raw' }); start(); },
  },
  raw: {
    label: 'Switch to sending page text',
    run: async () => { await saveSettings({ mode: 'raw' }); start(); },
  },
  smaller_model: {
    label: 'Use the smaller model',
    run: async () => { await saveSettings({ modelSize: 'small' }); start(); },
  },
  not_configured: {
    label: 'Open settings',
    run: () => openSettings(true),
  },
};

// ---------------------------------------------------------------- actions ---
async function start() {
  show('state-working');
  $('stage-name').textContent = 'Reading the page';
  $('stage-count').textContent = '';
  $('bar-fill').style.width = '10%';
  renderJob(await toBackground(MSG.START_CAPTURE, { tabId }));
}

function openSettings(open) {
  $('view-main').hidden = open;
  $('view-settings').hidden = !open;
  $('toggle-settings').textContent = open ? '✕' : '⚙';
}

// ---------------------------------------------------------------- settings ---
function renderProviderFields() {
  const provider = getProvider($('provider').value);
  const saved = settings.providers?.[provider.id] ?? {};
  $('provider-fields').replaceChildren(...provider.fields.map((field) => {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = field.required ? field.label : `${field.label} (optional)`;
    const input = document.createElement('input');
    input.type = field.type;
    input.id = `field-${field.key}`;
    input.placeholder = field.placeholder ?? '';
    input.value = saved[field.key] ?? field.default ?? '';
    label.append(span, input);
    return label;
  }));
}

function renderModelNote() {
  $('model-note').textContent = MODELS[$('model-size').value]?.note ?? '';
}

function renderSettings() {
  $(`mode-${settings.mode}`).checked = true;
  $('model-field').hidden = settings.mode !== 'distill';

  // Label only: the note does not fit in a 360px select and truncates.
  $('model-size').replaceChildren(...Object.entries(MODELS).map(([size, model]) =>
    new Option(model.label, size, false, size === settings.modelSize)));
  renderModelNote();

  $('provider').replaceChildren(...Object.values(PROVIDERS).map((p) =>
    new Option(p.label, p.id, false, p.id === settings.providerId)));

  renderProviderFields();
}

async function save() {
  const providerId = $('provider').value;
  const provider = getProvider(providerId);
  const config = Object.fromEntries(
    provider.fields.map((f) => [f.key, $(`field-${f.key}`).value.trim()]),
  );

  settings = await saveSettings({
    mode: document.querySelector('input[name=mode]:checked').value,
    modelSize: $('model-size').value,
    providerId,
    providers: { ...settings.providers, [providerId]: config },
  });

  const missing = missingFields(provider, config);
  $('save-note').textContent = missing.length
    ? `Saved. ${provider.label} still needs: ${missing.join(', ')}.`
    : 'Saved.';
  renderIdleHint();
}

function renderIdleHint() {
  const provider = getProvider(settings.providerId);
  const missing = missingFields(provider, providerConfig(settings));
  if (missing.length) {
    $('idle-hint').innerHTML = '';
    $('idle-hint').textContent = `${provider.label} needs ${missing.join(' and ')} — open settings.`;
    return;
  }
  const where = settings.mode === 'distill'
    ? `Summarised here, then sent to ${provider.label}.`
    : `Page text sent to ${provider.label}.`;
  $('idle-hint').innerHTML = `${where}<br>or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>`;
}

// ------------------------------------------------------------------- boot ---
(async function boot() {
  settings = await loadSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  $('page-title').textContent = tab?.title ?? 'This page';
  $('page-url').textContent = tab?.url ?? '';

  renderSettings();
  renderIdleHint();

  $('remember').onclick = start;
  $('retry').onclick = start;
  $('again').onclick = start;
  $('save').onclick = save;
  $('provider').onchange = renderProviderFields;
  $('model-size').onchange = renderModelNote;
  $('toggle-settings').onclick = () => openSettings($('view-settings').hidden);
  for (const el of document.querySelectorAll('input[name=mode]')) {
    el.onchange = (e) => { $('model-field').hidden = e.target.value !== 'distill'; };
  }

  // Reattach to whatever is already running for this tab.
  if (tabId != null) renderJob(await toBackground(MSG.GET_CAPTURE_STATE, { tabId }));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'JOB_UPDATE' && msg.job?.tabId === tabId) renderJob(msg.job);
    return false;
  });
})();
