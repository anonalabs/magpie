# phase-0 spike

Answers four questions before any real code is written. Load unpacked from this
directory (`chrome://extensions` → Developer mode → Load unpacked).

## S1 — does the offscreen document survive service-worker death?

1. Click **1. ensure offscreen**, then **2. ping offscreen**. Note `instanceId`.
2. Open `chrome://serviceworker-internals`, find the extension, click **Stop**.
   (Or just wait ~40s with the popup closed.)
3. Reopen the popup and click **2. ping offscreen** again.

**Pass:** same `instanceId`, and `uptimeMs` has kept climbing.
**Fail:** a new `instanceId` — the document was torn down with the worker, and
the engine would be reloaded (and the model re-initialised) constantly.

## S2 — can a job outlive the worker?

1. Click **3. start 90s job**. Close the popup immediately.
2. Wait ~100s, doing nothing (the worker will idle out at 30s).
3. Reopen the popup, click **4. read job state**.

**Pass:** `state: "done"`, `done === total`, same `instanceId`. A long distill
survives with no keepalive hack.
**Fail:** job missing or `running` and stalled — the SW must be kept alive with a
20s ping, and the architecture gets meaningfully worse.

## S4 — does a keyboard shortcut grant activeTab?

1. Open any ordinary page (e.g. a Wikipedia article). Do **not** open the popup.
2. Press <kbd>Ctrl/Cmd+Shift+M</kbd>. The toolbar badge should show `✓`.
3. Open the popup and click **5. sw info + S4 result**.

**Pass:** `s4.ok === true` with the page title and a char count. The shortcut path
needs no host permissions.
**Fail:** an error mentioning permissions — the extension needs `<all_urls>`,
which is a far heavier install prompt and a harder store review.

Note: the shortcut may be unbound if another extension claimed it; check
`chrome://extensions/shortcuts`.

## S3 — bundled WASM

Not covered here: it needs the real WebLLM dependency and the vendored model
libs, so it is verified in the main project once those exist.

---

## Results — 2026-09-11, Chrome 134.0.6998.165

Run: `node spikes/phase0/run-spike.mjs` (headless; `--headful` to watch).

| | Verdict | Evidence |
|---|---|---|
| **S1** offscreen survives SW death | **PASS** | Worker observed terminated at ~30s. Offscreen `instanceId` unchanged (`e6c85dfa`) across it, uptime still climbing at 60s. |
| **S2** job outlives the SW | **PASS** | 45s job started, popup closed, worker died at 30s; job read back `done 45/45` from a popup opened afterwards. |
| **S3** bundled WASM | pending | Needs the WebLLM dependency; verified in the main project. |
| **S4** shortcut grants activeTab | registration PASS | `chrome.commands.getAll()` reports `Alt+Shift+M`. The keypress itself is not scriptable — finish it by hand per the steps above. |

**Finding, and it cost a run to see: `Ctrl/Cmd+Shift+M` never binds.** Chrome
reserves it for profile switching, so `chrome.commands` accepts the manifest,
registers the command, and hands back an empty `shortcut` — no warning, no
install-time error, and the feature is simply dead. `Alt+Shift+M` binds. Anything
that ships a `suggested_key` should assert `getAll()[i].shortcut` is non-empty
rather than trusting the manifest.

Consequence for the build: **the service worker may be treated as disposable.**
`startCapture` can hand a job to the offscreen document and return, with no
keepalive ping and no port held open to prop the worker up.
