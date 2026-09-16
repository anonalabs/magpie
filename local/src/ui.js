// Drawing on a terminal.
//
// Pure, so it can be tested without a terminal: every function takes what it
// needs and returns a string. Colour is decided once, here, and honours NO_COLOR
// and a pipe, because output that is read by another program should not be full
// of escape codes.

const plain = process.env.NO_COLOR !== undefined
  || process.env.TERM === 'dumb'
  || !process.stdout.isTTY;

const wrap = (open, close) => (text) => (plain ? String(text) : `[${open}m${text}[${close}m`);

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);

// magpie's red, as close as a terminal gets, with a 16-colour fallback for the
// terminals that do not do truecolour.
export const accent = (text) => (plain ? String(text) : `[38;5;203m${text}[39m`);
export const green = (text) => (plain ? String(text) : `[38;5;71m${text}[39m`);
export const grey = (text) => (plain ? String(text) : `[38;5;245m${text}[39m`);

/** Length as the terminal sees it: escape codes take no columns. */
export const width = (text) => String(text).replace(/\[[0-9;]*m/g, '').length;

export const pad = (text, to) => String(text) + ' '.repeat(Math.max(0, to - width(text)));

/** A label and a value, aligned down the page. */
export const row = (label, value, labelWidth = 14) => `  ${grey(pad(label, labelWidth))}${value}`;

export function heading(text) {
  return `\n${bold(text)}`;
}

/** Thousands separated, because 12043 chunks should not have to be counted. */
export const count = (n) => Number(n ?? 0).toLocaleString('en-US');

export function bytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  // One decimal where it says something, none where it does not: "5.0 MB" is
  // a number that has been formatted at you.
  const shown = value < 10 && unit > 0 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${shown} ${units[unit]}`;
}

export function since(date) {
  if (!date) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function uptime(date) {
  if (!date) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  return hours < 24 ? `${hours}h ${Math.floor((seconds % 3600) / 60)}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Fourteen days of capture in fourteen characters. */
export function sparkline(values) {
  if (!values.length) return '';
  const top = Math.max(...values);
  if (top === 0) return grey(BLOCKS[0].repeat(values.length));
  return values.map((v) => (v === 0 ? grey(BLOCKS[0]) : accent(BLOCKS[Math.min(7, Math.ceil((v / top) * 7))]))).join('');
}

/** How much of the store has been embedded, as something you can see at a glance. */
export function bar(done, total, size = 24) {
  if (!total) return grey('─'.repeat(size));
  const filled = Math.round((done / total) * size);
  return accent('━'.repeat(filled)) + grey('━'.repeat(size - filled));
}

/** The bird, small enough to sit above a status block. */
export const mark = () => `${accent('\u25cf')} ${bold('magpie')}${grey('-local')}`;
