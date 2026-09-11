// A minimal but genuinely valid PDF, built by hand.
//
// The alternative was a dependency to test a dependency. This writes the object
// graph and a correct xref table, so pdf.js parses it the same way it parses a
// real one rather than falling back to its damaged-file recovery path — which
// would make the test pass for the wrong reason.

const escape = (text) => text.replace(/([\\()])/g, '\\$1');

/** Greedy word wrap, so no line runs past the right edge of the page. */
function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line + ' ' + word).length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

export function makePdf(pageCount, line = (n) => `Page ${n} of the test document.`) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };   // 1-based

  const catalogId = 1;
  const pagesId = 2;
  objects.push('', '');                                                   // reserved

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds = [];
  for (let n = 1; n <= pageCount; n++) {
    const text = `${line(n)} This page carries enough words to be worth extracting, `
      + `and a marker that identifies it precisely: marker-${n}-end.`;

    // Wrapped into lines, the way a real PDF is. A single long run at 12pt
    // Helvetica overflows the 540pt of usable width, and everything past the
    // page edge is simply absent from getTextContent — so an unwrapped fixture
    // silently tests a truncated document.
    const stream = ['BT', '/F1 12 Tf', '72 720 Td', '14 TL'];
    for (const chunk of wrap(text, 70)) stream.push(`(${escape(chunk)}) Tj`, 'T*');
    stream.push('ET');
    const body = stream.join('\n');
    const contentId = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] `
      + `/Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    ));
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;

  // Offsets are counted in bytes as the file is assembled; the xref table is
  // wrong otherwise and pdf.js silently switches to recovery.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
