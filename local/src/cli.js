#!/usr/bin/env node
// magpie-local: the store, the API magpie writes to, and the MCP server Claude
// reads from.
//
//   magpie-local serve     the HTTP API, plus background embedding
//   magpie-local mcp       the MCP server on stdio, for `claude mcp add`
//   magpie-local token     print the token, for pasting into magpie
//   magpie-local stats     what is in the store
//
// `serve` and `mcp` are separate processes on purpose. Claude launches the MCP
// one itself and owns its lifetime; the HTTP one runs while the browser does.
// They share the file, which is what SQLite is for.

import { DEFAULT_PORT, DB_PATH, EMBED_MODEL, token, tokenExists } from './config.js';
import { open, stats } from './db.js';
import { backfillLoop, embed, embedIfReady, isReady } from './embed.js';
import { createApi } from './http.js';
import { serveStdio } from './mcp.js';

const VERSION = '0.1.0';
const [command = 'serve'] = process.argv.slice(2);

// Everything the CLI prints goes to stderr when the MCP server is running:
// stdout is the protocol, and one stray line of chat corrupts the stream.
const say = (...args) => console.error(...args);

async function serve() {
  const first = !tokenExists();
  const secret = token();
  const db = open();

  const server = createApi({ db, token: secret, embed: embedIfReady, version: VERSION });
  server.listen(DEFAULT_PORT, '127.0.0.1', () => {
    const counts = stats(db);
    say(`magpie-local ${VERSION}  http://127.0.0.1:${DEFAULT_PORT}`);
    say(`  ${DB_PATH}`);
    say(`  ${counts.pages} pages, ${counts.chunks} chunks, ${counts.vectors} embedded`);
    if (!isReady()) say('  keyword search is live now; semantic search joins in once the model has loaded');
    if (first) {
      say('');
      say('  Paste this into magpie (Settings, Local store, Token):');
      say('');
      say(`      ${secret}`);
      say('');
      say('  It is in ~/.magpie/token if you need it again.');
    }
    say('');
    say('  Let Claude read it:');
    say(`      claude mcp add magpie -- npx magpie-local mcp`);
  });

  // The model loads on first use, not at startup, so captures and keyword
  // search work while 130MB is still arriving.
  backfillLoop(db, {
    onProgress: (p) => {
      if (p.error) return say(`  embedding paused: ${p.error}`);
      say(`  embedded ${p.embedded}, ${p.remaining ? `${p.remaining}+ to go` : 'up to date'}`);
    },
  });

  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function mcp() {
  const db = open();
  await serveStdio({ db, embed, version: VERSION });
  say(`magpie-local ${VERSION} speaking MCP on stdio (${DB_PATH})`);
}

switch (command) {
  case 'serve': await serve(); break;
  case 'mcp': await mcp(); break;
  case 'token': console.log(token()); break;
  case 'stats': {
    const counts = stats(open());
    console.log(`${counts.pages} pages, ${counts.chunks} chunks, ${counts.vectors} embedded`);
    console.log(`model ${EMBED_MODEL}, ${DB_PATH}`);
    break;
  }
  default:
    say(`magpie-local ${VERSION}`);
    say('  magpie-local serve | mcp | token | stats');
    process.exit(1);
}
