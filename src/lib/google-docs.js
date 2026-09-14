// Google Docs, Sheets and Slides.
//
// These pages cannot be read the way every other page is read: since 2021 the
// editor paints the document into a <canvas>, so the text is not in the DOM at
// all and Readability comes back with an empty page or the menu bar. The
// document's own export endpoint is the text, and it is on the same origin as
// the tab the reader is looking at, which is what makes this possible without
// asking for a new permission or handling anybody's Google credentials: the
// fetch is made by the page itself, with the session it already has.
//
// Pure: URL shapes, the cap, and telling a sign-in wall from a document.

/**
 * Editor URLs only. A *published* doc (`/document/d/e/<id>/pub`) is served as
 * ordinary HTML and Readability handles it correctly, so it deliberately does
 * not match here: intercepting it would replace something that works.
 */
const KINDS = [
  {
    kind: 'document',
    label: 'Google Doc',
    suffix: ' - Google Docs',
    pattern: /^\/document\/d\/(?!e\/)([^/]+)/,
    exportPath: (id) => `/document/d/${id}/export?format=txt`,
  },
  {
    kind: 'spreadsheet',
    label: 'Google Sheet',
    suffix: ' - Google Sheets',
    pattern: /^\/spreadsheets\/d\/(?!e\/)([^/]+)/,
    // Sheets export one tab at a time. `gid` rides in the fragment of the URL
    // being looked at, so what is captured is the sheet on screen rather than
    // whichever one happens to be first in the file.
    exportPath: (id, gid) => `/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`,
  },
  {
    kind: 'presentation',
    label: 'Google Slides deck',
    suffix: ' - Google Slides',
    pattern: /^\/presentation\/d\/(?!e\/)([^/]+)/,
    exportPath: (id) => `/presentation/d/${id}/export/txt`,
  },
];

/**
 * What kind of Google document this URL is, and where its text lives.
 * Returns null for anything else, including Drive, Forms and published docs.
 */
export function googleDoc(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.hostname !== 'docs.google.com') return null;

  for (const entry of KINDS) {
    const id = parsed.pathname.match(entry.pattern)?.[1];
    if (!id) continue;
    const gid = parsed.hash.match(/gid=([0-9]+)/)?.[1] ?? '';
    return {
      kind: entry.kind,
      label: entry.label,
      id,
      exportPath: entry.exportPath(id, gid),
      origin: parsed.origin,
    };
  }
  return null;
}

/** Whether this URL is one of them at all. */
export const looksLikeGoogleDoc = (url) => googleDoc(url) !== null;

/**
 * The tab title is the document's name with the product appended. The reader
 * named the file; "Q3 planning" is the title, not "Q3 planning - Google Docs".
 */
export function docTitle(tabTitle, kind) {
  const raw = String(tabTitle ?? '').trim();
  const entry = KINDS.find((k) => k.kind === kind);
  if (entry && raw.endsWith(entry.suffix)) return raw.slice(0, -entry.suffix.length).trim() || raw;
  return raw;
}

/**
 * An export that is not the document. Google answers a request it will not serve
 * with an HTML page: a sign-in wall, or the "you need permission" page. Both
 * arrive as a 200 with text, so the status code alone cannot tell them apart,
 * and storing one would file a login screen as though it were the document.
 */
export function looksLikeSignIn(text, contentType = '') {
  if (/text\/html/i.test(contentType)) return true;
  const head = String(text ?? '').slice(0, 2000).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html')
    || head.includes('accounts.google.com/signin');
}

/**
 * A very large export is capped for the same reason a PDF is: what follows is
 * one local model call per few thousand characters, and a book-length document
 * is tens of minutes of GPU nobody asked for.
 */
export const MAX_CHARS = 200_000;

/** Says what was read, in the text, because metadata is not what gets recalled. */
export function truncationNotice(charsRead, charsTotal, label) {
  if (charsRead >= charsTotal) return '';
  const percent = Math.max(1, Math.round((charsRead / charsTotal) * 100));
  return `(Summarised from the first ${percent}% of this ${label}.)`;
}

/** The text to distil, plus what to record about how much of it was covered. */
export function docBody(text, label, maxChars = MAX_CHARS) {
  const full = String(text ?? '').replace(/\r\n/g, '\n').trim();
  const read = full.slice(0, maxChars);
  const notice = truncationNotice(read.length, full.length, label);

  return {
    text: notice ? `${read}\n\n${notice}` : read,
    charsRead: read.length,
    charsTotal: full.length,
    truncated: Boolean(notice),
  };
}
