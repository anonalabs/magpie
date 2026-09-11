// Runs in the page, once, on demand. Injected by chrome.scripting.executeScript
// when the user asks for a capture — never declared in the manifest, so magpie
// is not resident on every page you visit.
//
// This file defines a function and does not call it. esbuild wraps the bundle in
// an IIFE, so the "value of the last statement" that executeScript({files}) hands
// back would be undefined; the caller injects this, then a one-line func that
// calls MAGPIE_EXTRACT and returns its value.

import { Readability } from '@mozilla/readability';

globalThis.MAGPIE_EXTRACT = function extract() {
  let article = null;
  try {
    // Readability mutates the document it is handed, which would visibly
    // rearrange the page the user is looking at. Parse a clone.
    article = new Readability(document.cloneNode(true)).parse();
  } catch (err) {
    return { ok: false, code: 'extract_failed', message: `Could not read this page. ${err.message}` };
  }

  const text = (article?.textContent ?? '').trim();
  // Boilerplate-only pages (nav shells, app frames, cookie walls) parse down to a
  // sentence or two. Storing those is worse than storing nothing: on the way back
  // out they are indistinguishable from real memories.
  if (text.length < 280) {
    return { ok: false, code: 'no_article', message: "There isn't enough readable text on this page to remember." };
  }

  return {
    ok: true,
    title: (article.title || document.title || location.hostname).trim(),
    url: location.href,
    text,
    excerpt: (article.excerpt ?? '').trim(),
    siteName: (article.siteName ?? '').trim(),
  };
};
