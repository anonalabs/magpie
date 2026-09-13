# Capture-time control

Status: approved 2026-09-11. Second of three pieces. Writes through the queue
built in `2026-09-11-durable-capture-design.md`.

## The problem

The model can say what a page contains. It cannot say why you kept it, and that
is usually the part worth recalling. There is also no way to keep a passage you
highlighted rather than the page it sat in.

## The constraint this has to respect

magpie's interaction model is one verb: you press Remember and the page is
remembered, with the summary shown afterwards as a receipt rather than before as
a checkpoint. "Edit the summary before saving" puts that checkpoint back on
every capture, which is the friction the design deliberately removed.

So annotating is **a second gesture**, not a step added to the first.

- `Alt+Shift+M`: unchanged. Instant, no prompt.
- `Alt+Shift+N`: compose. Note, edit, then save.
- Right-click the in-page button: compose.
- Right-click a selection: *Remember this selection*.

## Compose costs no waiting

Opening compose starts the distill immediately. You write the note while the
model runs, and the summary arrives in an editable field when it is ready. The
waiting time becomes the typing time rather than being added to it.

In raw mode there is no summary, so compose is the note alone. For a selection
there is no model at all.

A draft is written to `chrome.storage.session` as it is typed. The browser action
popup closes whenever focus leaves it, and losing a half-written note to a stray
click would make the feature untrustworthy.

## The note goes into the content

```
why I saved this

---

the summary
```

Not into `metadata`. Memory layers extract from content and largely ignore
metadata, so a note stored there would be kept and never found; worse than not
offering one, because it would look like it worked. `metadata.note` is mirrored
for provenance only.

## Selection is verbatim

You already chose those words. Summarising a highlighted paragraph into a
shorter paraphrase discards the only thing the selection had going for it. So a
selection is stored exactly as selected: no model, instant, and it works on a
machine with no WebGPU.

**`info.selectionText` is truncated by Chrome**, so the full selection is read
with `chrome.scripting.executeScript` against `window.getSelection()` rather than
taken from the context-menu event. Using the event's copy would silently store a
clipped quote, which is the kind of bug nobody notices until the memory is
useless.

## Record

Two fields added to the capture record from piece 1:

- `note`: the text the reader wrote, or absent.
- `sourceKind`: `'page' | 'selection'`.

Both ride into `metadata`. `mode` records what actually produced the content
(`distill`, `raw`, `selection`).

## Opening the popup from a shortcut

`chrome.action.openPopup()` is Chrome 127+, and the manifest's floor is 116. It
is called when present; where it is not, the compose request is parked and the
badge marks it, so the next time the popup is opened it opens into compose. The
shortcut never silently does nothing.

## Permissions

Adds `contextMenus`. Registration is guarded the way `alarms` now is: a
permission added in a build is invisible to Chrome until the extension is
reloaded, and an unguarded call to a missing API at the top of the service worker
kills the worker and takes every capture with it.

## Files

| File | Change |
|---|---|
| `src/lib/compose.js` | **new**, pure: joining note and body, and the metadata shape. |
| `src/background.js` | compose command, context menus, selection capture, draft routing. |
| `src/offscreen.js` | a draft run that produces a summary and stops short of the queue. |
| `src/popup.{html,js,css}` | the compose view and its saved draft. |
| `src/content-script.js` | reading the full selection. |
| `scripts/build.mjs` | `contextMenus`, and the `compose-page` command. |

## Testing

Unit, on the pure part: a note joins the body in the right order and with a
separator; no note produces byte-identical content to today, so the fast path is
provably unchanged; the metadata carries the note without it being the only copy.

End to end: compose saves a note inside `content` and not only in `metadata`; a
selection is stored verbatim and never invokes the model; a selection longer than
Chrome's `selectionText` truncation arrives whole.

## Out of scope

Tags: three provider mappings and one of them barely works. Editing a memory
after it has been written. PDFs and YouTube, which are piece 3 of 3.
