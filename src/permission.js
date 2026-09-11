// Asking for the optional all-sites permission, from a tab.
//
// This exists because a popup cannot do it. Chrome closes the popup to show the
// permission prompt, which destroys the page that was awaiting the answer — the
// checkbox appears to do nothing at all. A normal extension page survives the
// prompt, so the answer actually comes back.

import { MSG, toBackground } from './lib/messages.js';

const ALL_SITES = { origins: ['http://*/*', 'https://*/*'] };
const $ = (id) => document.getElementById(id);

function report(kind, text, done = false) {
  const state = $('state');
  state.className = `status ${kind}`;
  state.firstElementChild.textContent = text;
  $('allow').hidden = done;
  $('close').textContent = done ? 'Close this tab' : 'Not now';
}

async function refresh() {
  if (await chrome.permissions.contains(ALL_SITES)) {
    report('good', 'magpie is on your pages. Look for the button in the corner.', true);
  }
}

$('allow').onclick = async () => {
  // Chrome re-reads an unpacked extension's FILES from disk on every load, but
  // caches the parsed MANIFEST until the extension is reloaded. So a fresh build
  // can serve this very page while Chrome still runs the previous manifest — and
  // the only symptom is "Only permissions specified in the manifest may be
  // requested", which sounds like a bug in the request rather than a stale load.
  if (!chrome.runtime.getManifest().optional_host_permissions?.length) {
    return report('bad', 'This extension needs reloading: open chrome://extensions and press '
      + 'reload on magpie, then come back. Chrome is still running an older manifest.');
  }

  let granted = false;
  try {
    granted = await chrome.permissions.request(ALL_SITES);
  } catch (err) {
    return report('bad', `Chrome refused the request. ${err.message ?? err}`);
  }

  if (!granted) return report('bad', 'Not allowed, so there is no button on pages. Nothing else changed.');

  // The service worker also watches permissions.onAdded; this just makes the
  // registration immediate rather than whenever the worker next wakes.
  const sync = await toBackground(MSG.SYNC_IN_PAGE);

  // Reported honestly. Announcing success here regardless of what came back is
  // what previously turned a failed registration into "Done." plus no button.
  if (sync?.error) {
    return report('bad', `Chrome allowed it, but the button could not be installed: ${sync.error}`);
  }
  if (!sync?.granted) {
    return report('bad', 'Chrome reported the permission as not granted. Try reloading the extension '
      + 'at chrome://extensions and allowing again.');
  }
  if (!sync?.registered) {
    return report('bad', 'The permission is granted but the button is not installed. Reload the '
      + 'extension at chrome://extensions.');
  }

  // Say what happened to the tabs already open, because that is where the reader
  // will look first and a content script normally reaches none of them.
  report('good', sync.injected
    ? `Done. The button is on ${sync.injected} open tab${sync.injected === 1 ? '' : 's'} already, and on every page from now on.`
    : 'Done, but no open tab could take it — open a new page and look in the corner.', true);
};

$('close').onclick = () => window.close();

refresh();
