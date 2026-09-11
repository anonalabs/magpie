// Turning a PDF's pages into the text the rest of the pipeline already knows how
// to handle.
//
// Pure: it takes the strings pdf.js produced and nothing else. What lives here
// is the cap and the honesty about it, which are the two parts worth pinning.

/**
 * Forty pages. A three-hundred-page PDF is around a hundred local model calls
 * and tens of minutes of GPU, which is not a thing to begin without asking.
 */
export const MAX_PAGES = 40;

/**
 * Pages are joined with a blank line so the existing chunker sees page breaks as
 * paragraph boundaries. Without that a chunk can begin mid-sentence across a
 * page, which summarises noticeably worse.
 */
export function joinPages(pages) {
  return pages
    .map((page) => String(page ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Says what was actually read, in the text itself.
 *
 * Deliberately not metadata-only: memory layers extract from content and largely
 * ignore metadata, so a caveat stored there would be invisible at exactly the
 * moment it matters — when a summary of the opening chapter is recalled as
 * though it covered the whole document.
 */
export function truncationNotice(pagesRead, pagesTotal) {
  if (pagesRead >= pagesTotal) return '';
  return `(Summarised from the first ${pagesRead} of ${pagesTotal} pages.)`;
}

/**
 * The text to distil, plus what to record about how much of the document it
 * covers.
 */
export function pdfBody(pages, pagesTotal, maxPages = MAX_PAGES) {
  const read = pages.slice(0, maxPages);
  const body = joinPages(read);
  const notice = truncationNotice(read.length, pagesTotal);

  return {
    text: notice ? `${body}\n\n${notice}` : body,
    pagesRead: read.length,
    pagesTotal,
    truncated: Boolean(notice),
  };
}

/** Whether this is a PDF, from the URL alone — before anything has been fetched. */
export function looksLikePdf(url) {
  try {
    // The query string is not part of the name: ...\/paper.pdf?download=1 is a PDF.
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}
