// Splitting an article to fit a 4096-token context window.
//
// Pure: no browser APIs, no imports. That is deliberate — this is the only part
// of magpie whose behaviour can be pinned by fast unit tests, so everything that
// can live here does.
//
// The rule throughout: cut at the largest structural boundary that works, and
// only fall to a smaller one when the larger one leaves a piece that still does
// not fit. A chunk that begins mid-sentence summarises noticeably worse, and a
// chunk that begins mid-word is just noise.

/** Characters per token for ordinary prose. Used as a floor, never alone. */
export const CHARS_PER_TOKEN = 4;

// Alphanumeric runs, and every other non-space character on its own. A BPE
// tokenizer splits roughly this way: words become one token or a few, and each
// piece of punctuation tends to cost one.
const PIECES = /[A-Za-z0-9]+|[^\sA-Za-z0-9]/g;

/**
 * How many tokens a string is likely to cost.
 *
 * The flat length/4 this used to be is right for English prose and badly wrong
 * for anything else: measured 43% low on code and 54% low on text full of URLs.
 * Underestimating is the dangerous direction — it overfills the context window,
 * and an overflowing prompt comes back as an empty summary rather than an error.
 *
 * Still an estimate, not a tokenizer. It is deliberately pessimistic, and
 * nothing depends on it being right: an empty answer is retried on a smaller
 * piece regardless.
 */
export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;

  let tokens = 0;
  for (const piece of value.match(PIECES) ?? []) {
    tokens += /^[A-Za-z0-9]+$/.test(piece) ? Math.max(1, Math.ceil(piece.length / CHARS_PER_TOKEN)) : 1;
  }

  // Scripts with no word runs at all — CJK and similar — match nothing above,
  // so the flat ratio is the floor rather than the answer.
  return Math.max(tokens, Math.ceil(value.length / CHARS_PER_TOKEN));
}

/**
 * The budget available for article text in one call, given the model's context
 * window. Everything subtracted here has to be, or the model silently truncates
 * the end of the chunk and summarises a document it only partly saw.
 */
export function inputBudget(contextWindow, { promptTokens = 150, outputTokens = 350, safety = 96 } = {}) {
  const budget = contextWindow - promptTokens - outputTokens - safety;
  if (budget < 200) throw new RangeError(`context window ${contextWindow} is too small to summarise anything`);
  return budget;
}

/** Paragraph, heading and list boundaries — one or more blank lines. */
function byBlankLine(text) {
  return text.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
}

const SPLITTERS = [
  byBlankLine,
  (text) => text.split(/\n+/).map((s) => s.trim()).filter(Boolean),
  // Sentence end followed by whitespace. Keeps the terminator on the left piece.
  (text) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean),
  (text) => text.split(/\s+/).filter(Boolean),
];

/** Characters of THIS text that are likely to fit a token budget. */
function charsFor(text, budgetTokens) {
  const density = estimateTokens(text) / Math.max(1, text.length);   // tokens per char
  return Math.max(80, Math.floor(budgetTokens / density));
}

/**
 * Break one oversized piece down until every part fits, trying progressively
 * finer boundaries. A single unbroken run over budget (a minified script, a
 * base64 blob, CJK text with no spaces) is hard-cut as a last resort.
 */
function breakDown(text, budgetTokens, depth = 0) {
  if (estimateTokens(text) <= budgetTokens) return [text];

  const splitter = SPLITTERS[depth];
  if (!splitter) {
    // Measured against this text's own density rather than a flat ratio: a run
    // of dense characters costs far more tokens than the same length of prose.
    const width = charsFor(text, budgetTokens);
    const out = [];
    for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
    return out;
  }

  const parts = splitter(text);
  // This boundary did not exist in the text; go finer without re-packing.
  if (parts.length <= 1) return breakDown(text, budgetTokens, depth + 1);

  const joiner = depth === 0 ? '\n\n' : depth === 3 ? ' ' : '\n';
  return pack(parts, budgetTokens, joiner, depth + 1);
}

/**
 * Greedily fill chunks with consecutive parts, never crossing the budget.
 *
 * Measured in tokens, not characters. Sizing by characters and hoping the ratio
 * holds is what overfilled the context window on dense text, and an overfull
 * prompt comes back as an empty summary rather than an error.
 */
function pack(parts, budgetTokens, joiner, depth) {
  const chunks = [];
  const joinerCost = estimateTokens(joiner);
  let current = '';
  let currentTokens = 0;

  const flush = () => {
    if (current) chunks.push(current);
    current = '';
    currentTokens = 0;
  };

  for (const part of parts) {
    const partTokens = estimateTokens(part);

    if (partTokens > budgetTokens) {
      flush();
      chunks.push(...breakDown(part, budgetTokens, depth));
      continue;
    }

    const combined = currentTokens + (current ? joinerCost : 0) + partTokens;
    if (current && combined > budgetTokens) flush();

    current = current ? current + joiner + part : part;
    currentTokens = current === part ? partTokens : combined;
  }

  flush();
  return chunks;
}

/**
 * Split `text` into pieces that each fit `budgetTokens`.
 * Text that already fits comes back as a single chunk, untouched.
 */
export function chunkText(text, budgetTokens) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];

  if (estimateTokens(trimmed) <= budgetTokens) return [trimmed];
  return pack(byBlankLine(trimmed), budgetTokens, '\n\n', 1);
}

/**
 * Plan the whole job up front, so progress can be reported as "chunk k of n"
 * instead of a spinner. A 20k-word article is around nine chunks and minutes of
 * work; an unlabelled spinner over that reads as a hang.
 */
export function planSummarisation(text, contextWindow, options) {
  const budget = inputBudget(contextWindow, options);
  const chunks = chunkText(text, budget);
  return {
    budgetTokens: budget,
    chunks,
    // One call per chunk, plus a reduce pass to fuse them when there are several.
    totalCalls: chunks.length + (chunks.length > 1 ? 1 : 0),
    needsReduce: chunks.length > 1,
  };
}

/**
 * After a map pass, decide whether the joined summaries can be reduced in one
 * call or need another round of chunking first.
 */
export function reducePlan(summaries, budgetTokens) {
  const joined = summaries.join('\n\n');
  return {
    joined,
    fits: estimateTokens(joined) <= budgetTokens,
    chunks: chunkText(joined, budgetTokens),
  };
}


/**
 * Cuts a piece of text roughly in half, at the best boundary near the middle.
 *
 * Used when the model answers with nothing, which nearly always means the prompt
 * overran the context window — the estimate above is only an estimate, and this
 * is what stops it being load-bearing. Returns a single-element array when there
 * is no boundary to cut on, so the caller can tell the difference between
 * "smaller" and "cannot be made smaller".
 */
export function splitInHalf(text) {
  const value = String(text ?? '').trim();
  if (value.length < 2) return [value].filter(Boolean);

  const middle = Math.floor(value.length / 2);
  // Best boundary first: paragraph, then line, then sentence, then any space.
  for (const boundary of [/\n\s*\n/g, /\n/g, /(?<=[.!?])\s/g, /\s/g]) {
    let best = -1;
    for (const match of value.matchAll(boundary)) {
      const at = match.index + match[0].length;
      if (at <= 0 || at >= value.length) continue;
      if (best === -1 || Math.abs(at - middle) < Math.abs(best - middle)) best = at;
    }
    if (best > 0) {
      const left = value.slice(0, best).trim();
      const right = value.slice(best).trim();
      if (left && right) return [left, right];
    }
  }

  // No boundary anywhere — one unbroken run. Cut it rather than give up.
  const left = value.slice(0, middle).trim();
  const right = value.slice(middle).trim();
  return left && right ? [left, right] : [value];
}
