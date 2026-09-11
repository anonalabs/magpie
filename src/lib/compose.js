// Putting a reader's note together with what was captured.
//
// Pure, and small on purpose: the one rule worth protecting is that a capture
// with no note produces byte-identical content to a capture made before this
// feature existed. The fast path is the product; it must not drift because an
// optional field was added beside it.

export const NOTE_SEPARATOR = '\n\n---\n\n';

/**
 * The note comes first. It is the part a reader wrote and the part they will
 * search for — a memory layer that truncates or weights by position should see
 * it before the machine-written half.
 */
export function composeContent(note, body) {
  const written = (note ?? '').trim();
  const captured = (body ?? '').trim();
  if (!written) return captured;
  if (!captured) return written;
  return `${written}${NOTE_SEPARATOR}${captured}`;
}

/**
 * One metadata shape for every provider, rather than three that drift.
 *
 * The note is mirrored here for provenance, never stored here *instead* —
 * memory layers extract from content and largely ignore metadata, so a note that
 * lived only here would be kept and never found, which is worse than not
 * offering one because it looks like it worked.
 */
export function captureMetadata(capture) {
  const metadata = {
    url: capture.url,
    title: capture.title,
    captured_at: capture.capturedAt,
    source: 'magpie',
    mode: capture.mode,
  };

  const note = (capture.note ?? '').trim();
  if (note) metadata.note = note;
  // Only when it is not the ordinary case, so an everyday capture's metadata
  // stays exactly what it was.
  if (capture.sourceKind && capture.sourceKind !== 'page') metadata.source_kind = capture.sourceKind;

  // How much of a long document this actually covers. The content says so too;
  // this is for anything reading the record rather than the memory.
  if (capture.pagesTotal) {
    metadata.pages_read = capture.pagesRead;
    metadata.pages_total = capture.pagesTotal;
  }

  return metadata;
}
