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

/** Characters per token. An estimate, named as one — not a tokenizer. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
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

/**
 * Break one oversized piece down until every part fits, trying progressively
 * finer boundaries. A single unbroken run longer than the budget (a minified
 * script, a base64 blob, CJK text with no spaces) is hard-cut as a last resort.
 */
function breakDown(text, budgetChars, depth = 0) {
  if (text.length <= budgetChars) return [text];

  const splitter = SPLITTERS[depth];
  if (!splitter) {
    const out = [];
    for (let i = 0; i < text.length; i += budgetChars) out.push(text.slice(i, i + budgetChars));
    return out;
  }

  const parts = splitter(text);
  // This boundary did not exist in the text; go finer without re-packing.
  if (parts.length <= 1) return breakDown(text, budgetChars, depth + 1);

  const joiner = depth === 0 ? '\n\n' : depth === 3 ? ' ' : '\n';
  return pack(parts, budgetChars, joiner, depth + 1);
}

/** Greedily fill chunks with consecutive parts, never crossing the budget. */
function pack(parts, budgetChars, joiner, depth) {
  const chunks = [];
  let current = '';

  for (const part of parts) {
    if (part.length > budgetChars) {
      if (current) { chunks.push(current); current = ''; }
      chunks.push(...breakDown(part, budgetChars, depth));
      continue;
    }
    const candidate = current ? current + joiner + part : part;
    if (candidate.length <= budgetChars) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Split `text` into pieces that each fit `budgetTokens`.
 * Text that already fits comes back as a single chunk, untouched.
 */
export function chunkText(text, budgetTokens) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  if (trimmed.length <= budgetChars) return [trimmed];
  return pack(byBlankLine(trimmed), budgetChars, '\n\n', 1);
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
