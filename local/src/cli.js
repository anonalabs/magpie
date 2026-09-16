#!/usr/bin/env node
// magpie-local.
//
//   magpie-local              what is in the store, and whether it is running
//   magpie-local start        run it in the background
//   magpie-local stop         stop it
//   magpie-local restart
//   magpie-local serve        run it in the foreground (logs here, ctrl-c stops)
//   magpie-local mcp          speak MCP on stdio; Claude starts this itself
//   magpie-local search <q>   search the store from here
//   magpie-local token        print the token, for pasting into magpie
//
// This import comes first on purpose: it silences one warning, and it has to be
// evaluated before the database module is.
import './quiet.js';

import { DB_PATH, DEFAULT_PORT, EMBED_MODEL, HOME, token, tokenExists } from './config.js';
import { LOG_PATH, healthy, running, start, stop } from './daemon.js';
import { open } from './db.js';
import { backfillLoop, embed, embedIfReady, isReady } from './embed.js';
import { createApi } from './http.js';
import { serveStdio } from './mcp.js';
import { search } from './search.js';
import { report } from './stats.js';
import {
  accent, bar, bold, bytes, count, dim, green, grey, heading, mark, row, since, sparkline, uptime,
} from './ui.js';

const VERSION = '0.1.0';
const [command = 'status', ...rest] = process.argv.slice(2);

// stdout belongs to the MCP protocol when that is what is running, so anything
// the program says about itself goes to stderr. One stray line on stdout
// corrupts the stream and the failure looks like Claude being broken.
const say = (...args) => console.error(...args);

// ------------------------------------------------------------------ serve ---

async function serve() {
  const first = !tokenExists();
  const secret = token();
  const db = open();

  const server = createApi({ db, token: secret, embed: embedIfReady, version: VERSION });
  server.listen(DEFAULT_PORT, '127.0.0.1', () => {
    const counts = report(db, { dbPath: DB_PATH });
    say('');
    say(`  ${mark()} ${grey(VERSION)}   ${green('listening')} ${grey(`http://127.0.0.1:${DEFAULT_PORT}`)}`);
    say(row('store', `${grey(DB_PATH)}`));
    say(row('holding', `${count(counts.pages)} pages, ${count(counts.chunks)} passages`));
    if (!isReady()) say(row('', dim('keyword search is live now; semantic joins in once the model loads')));

    if (first) {
      say('');
      say(`  ${bold('Paste this into magpie')} ${grey('(Settings, This machine, Token)')}`);
      say('');
      say(`      ${accent(secret)}`);
      say('');
      say(grey('  It is in ~/.magpie/token if you need it again.'));
    }
    say('');
    say(grey('  Let Claude read it:  ') + `claude mcp add magpie -- npx magpie-local mcp`);
    say(grey('  Stop with ctrl-c, or run it in the background with `magpie-local start`.'));
    say('');
  });

  backfillLoop(db, {
    onProgress: (p) => {
      if (p.error) return say(grey(`  embedding paused: ${p.error}`));
      say(grey(`  embedded ${p.embedded}${p.remaining ? `, ${p.remaining}+ to go` : ', up to date'}`));
    },
  });

  const bye = () => { server.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

// ----------------------------------------------------------------- status ---

async function status() {
  const live = running();
  const health = await healthy();
  const db = open();
  const s = report(db, { dbPath: DB_PATH });

  const out = [];
  out.push('');
  out.push(`  ${mark()} ${grey(VERSION)}`);

  out.push(heading('  Service'));
  out.push(row('running', health && live
    ? `${green('yes')}  ${grey(`pid ${live.pid} · up ${uptime(live.startedAt)}`)}`
    : health
      ? `${green('yes')}  ${grey('started outside this command')}`
      : `${grey('no')}   ${dim('start it with `magpie-local start`')}`));
  if (health) out.push(row('listening', grey(`http://127.0.0.1:${DEFAULT_PORT}`)));
  out.push(row('store', `${grey(DB_PATH)}  ${dim(bytes(s.diskBytes))}`));

  out.push(heading('  Stored'));
  out.push(row('pages', count(s.pages)));
  out.push(row('passages', count(s.chunks)));
  out.push(row('embedded', s.chunks
    ? `${bar(s.vectors, s.chunks)}  ${count(s.vectors)}/${count(s.chunks)}`
      + (s.vectors < s.chunks ? dim('  working') : '')
    : dim('nothing to embed yet')));
  out.push(row('text', `${count(s.characters)} characters  ${dim(`~${count(s.words)} words`)}`));
  if (s.staleVectors) {
    out.push(row('', dim(`${count(s.staleVectors)} vectors from an older model, ignored and being rewritten`)));
  }

  if (s.spaces.length) {
    out.push(heading('  Where'));
    out.push(row('spaces', s.spaces.map((x) => `${x.space} ${grey(count(x.pages))}`).join(dim('  ·  '))));
    out.push(row('kinds', s.kinds.map((x) => `${x.kind} ${grey(count(x.pages))}`).join(dim('  ·  '))));
  }

  if (s.pages) {
    const today = s.days.at(-1)?.n ?? 0;
    out.push(heading('  Lately'));
    out.push(row('14 days', `${sparkline(s.days.map((d) => d.n))}  ${grey(`${count(today)} today`)}`));
    out.push(row('newest', `${s.newest?.title ?? ''}  ${grey(since(s.newest?.captured_at))}`));
    out.push(row('first', grey(since(s.oldest))));
  }

  out.push(heading('  Reading it'));
  out.push(row('claude', `claude mcp add magpie -- npx magpie-local mcp`));
  out.push(row('here', `magpie-local search ${dim('"what you are looking for"')}`));
  out.push(row('token', grey(`${HOME}/token`)));
  out.push(row('model', grey(s.model)));

  out.push('');
  out.push(dim('  Read from your own file and printed here. magpie has no telemetry:'));
  out.push(dim('  none of this is sent anywhere, by this command or by anything else.'));
  out.push('');
  console.log(out.join('\n'));
}

// ----------------------------------------------------------------- search ---

async function searchHere(query) {
  if (!query) { say(dim('  magpie-local search "what you are looking for"')); process.exit(1); }

  const db = open();

  // A one-shot command has no warm model, so `embedIfReady` would always skip
  // the semantic half. Loading from the cache takes a second or two, which is
  // worth waiting for; a first run that has to download 130MB is not, so it
  // gives up and says it rather than hanging on a search.
  let semantic = true;
  const embedOnce = (text) => Promise.race([
    embed(text),
    new Promise((resolve) => setTimeout(() => { semantic = false; resolve(null); }, 4000)),
  ]);

  const results = await search(db, query, { k: 8, embed: embedOnce });

  if (!results.length) {
    console.log(`\n  ${grey(`Nothing saved matches "${query}".`)}\n`);
    return;
  }

  const lines = [''];
  results.forEach((r, i) => {
    lines.push(`  ${accent(String(i + 1).padStart(2))}  ${bold(r.title)}`);
    lines.push(`      ${grey(r.url)}`);
    lines.push(`      ${dim(`${since(r.captured_at)} · ${r.space} · ${r.matched.join(' + ')}`)}`);
    // The store marks hits with brackets; turn them into colour rather than
    // leaving punctuation in the middle of a sentence.
    const snippet = r.snippet.replace(/\s+/g, ' ').trim()
      .replace(/\[([^\]]*)\]/g, (_, hit) => accent(hit));
    lines.push(`      ${snippet}`);
    lines.push('');
  });
  if (!semantic) lines.push(dim('  Keyword results only: the model was still loading.\n'));
  console.log(lines.join('\n'));
}

// -------------------------------------------------------------------- run ---

function help() {
  console.log([
    '',
    `  ${mark()} ${grey(VERSION)}  ${dim('a memory store on this machine')}`,
    '',
    `  ${bold('magpie-local')}              ${grey('what is in the store, and whether it is running')}`,
    `  ${bold('magpie-local start')}        ${grey('run it in the background')}`,
    `  ${bold('magpie-local stop')}         ${grey('stop it')}`,
    `  ${bold('magpie-local restart')}      ${grey('stop it, start it')}`,
    `  ${bold('magpie-local serve')}        ${grey('run it here, in the foreground')}`,
    `  ${bold('magpie-local search')} ${dim('<q>')}   ${grey('search the store from this terminal')}`,
    `  ${bold('magpie-local mcp')}          ${grey('speak MCP on stdio; Claude starts this itself')}`,
    `  ${bold('magpie-local token')}        ${grey('print the token, for pasting into magpie')}`,
    '',
  ].join('\n'));
}

switch (command) {
  case 'serve': await serve(); break;

  case 'start': {
    const result = await start();
    if (result.already) { say(`  ${green('already running')} ${grey(`pid ${result.pid}, up ${uptime(result.startedAt)}`)}`); break; }
    if (result.failed) {
      say(`  ${accent('it did not come up')}. The log is ${grey(LOG_PATH)}`);
      process.exit(1);
    }
    say(`  ${green('started')} ${grey(`pid ${result.pid} · http://127.0.0.1:${DEFAULT_PORT} · log ${LOG_PATH}`)}`);
    if (!tokenExists()) say(grey('  run `magpie-local token` for the token to paste into magpie'));
    break;
  }

  case 'stop': {
    const result = await stop();
    say(result.wasRunning ? `  ${green('stopped')} ${grey(`pid ${result.pid}`)}` : `  ${grey('not running')}`);
    break;
  }

  case 'restart': {
    await stop();
    const result = await start();
    say(result.failed
      ? `  ${accent('it did not come back up')}. The log is ${grey(LOG_PATH)}`
      : `  ${green('restarted')} ${grey(`pid ${result.pid}`)}`);
    break;
  }

  case 'status': await status(); break;
  case 'search': await searchHere(rest.join(' ')); break;
  case 'token': console.log(token()); break;

  case 'mcp': {
    const db = open();
    await serveStdio({ db, embed: embedIfReady, version: VERSION });
    say(`magpie-local ${VERSION} speaking MCP on stdio (${DB_PATH})`);
    break;
  }

  case 'help': case '--help': case '-h': help(); break;

  default:
    say(`  ${accent('no such command')}: ${command}`);
    help();
    process.exit(1);
}
