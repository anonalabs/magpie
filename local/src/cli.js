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
//   magpie-local install      start it with the computer, from now on
//   magpie-local uninstall    stop doing that
//   magpie-local token        print the token, for pasting into magpie
//
// This import comes first on purpose: it silences one warning, and it has to be
// evaluated before the database module is.
import './quiet.js';

import { DB_PATH, DEFAULT_PORT, EMBED_MODEL, HOME, token, tokenExists } from './config.js';
import { LOG_PATH, healthy, running, start, stop } from './daemon.js';
import { install, installed, serviceFile, uninstall } from './service.js';
import { open } from './db.js';
import { backfillLoop, embed, embedIfReady, isReady } from './embed.js';
import { createApi } from './http.js';
import { search } from './search.js';
import { report } from './stats.js';
import {
  accent, bar, bold, bytes, count, dim, green, grey, heading, mark, row, since, sparkline, uptime,
} from './ui.js';

const VERSION = '0.1.0';

/**
 * How to run this copy: the node binary and this file, unless it was started
 * through an installed `magpie-local` shim, in which case that is the stable
 * thing to point a service at. A service pointing into a checkout that later
 * moves is a service that silently stops working.
 */
function selfExec() {
  const script = process.argv[1] ?? '';
  return script.endsWith('cli.js')
    ? { exec: process.execPath, args: [script, 'serve'] }
    : { exec: script || 'magpie-local', args: ['serve'] };
}

function plan() {
  const { exec, args } = selfExec();
  return serviceFile({ platform: process.platform, exec, args, port: DEFAULT_PORT, logPath: LOG_PATH });
}
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
    say(grey('  Let Claude read it:  ') + `claude mcp add --scope user magpie -- magpie-local mcp`);
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
  out.push(row('at login', installed()
    ? `${green('yes')}  ${grey('it comes back on its own')}`
    : `${grey('no')}   ${dim('`magpie-local install` starts it with the computer')}`));
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
  out.push(row('claude', `claude mcp add --scope user magpie -- magpie-local mcp`));
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
    `  ${bold('magpie-local install')}      ${grey('start it with the computer, from now on')}`,
    `  ${bold('magpie-local uninstall')}    ${grey('stop doing that')}`,
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

  case 'install': {
    const service = plan();
    if (!service) { say(`  ${accent('no autostart for this platform')}: ${process.platform}`); process.exit(1); }

    const result = install(service);
    say(`  ${green('installed')} ${grey(result.path)}`);
    for (const line of result.ran) say(grey(`  ran ${line}`));
    if (result.failed) {
      say(`  ${accent('but')} \`${result.failed}\` did not run: ${result.error}`);
      say(grey('  The file is written; run that command yourself when you can.'));
    }
    say(grey(`  ${service.note}`));
    const up = await healthy();
    if (!up) say(grey('  Not answering yet; `magpie-local` will say when it is.'));
    break;
  }

  case 'uninstall': {
    const service = plan();
    if (!service) { say(`  ${grey('nothing to remove on this platform')}`); break; }
    const result = uninstall(service);
    say(result.existed ? `  ${green('removed')} ${grey(result.path)}` : `  ${grey('it was not installed')}`);
    for (const line of result.ran) say(grey(`  ran ${line}`));
    break;
  }

  case 'status': await status(); break;
  case 'search': await searchHere(rest.join(' ')); break;
  case 'token': console.log(token()); break;

  case 'mcp': {
    // Imported here rather than at the top: the MCP SDK and zod are only needed
    // by this one command, and loading them for `serve` means the store cannot
    // run anywhere they are not installed. That is not hypothetical, it is
    // what happens in CI, where only the root dependencies are installed and
    // the daemon died on startup with no explanation.
    const { serveStdio } = await import('./mcp.js');
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
