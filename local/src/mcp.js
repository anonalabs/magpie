// What Claude sees.
//
// Three tools, all read-only. Read-only is not caution for its own sake: a tool
// that writes is a tool a prompt injection in a web page can aim at your notes,
// and the writing surface already exists in the extension, behind a keypress
// that a person makes.
//
// There is no `ask` tool and no model in here. In an MCP setup the generation
// half of retrieval-augmented generation is the client: Claude is the thing
// doing the reasoning, so this server's whole job is to find the right text and
// hand it over. An LLM inside a retrieval server whose only caller is an LLM
// buys nothing and costs a second runtime, a second download and a GPU.

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getPage, getPageByUrl, recentPages } from './db.js';
import { search } from './search.js';

const text = (value) => ({ content: [{ type: 'text', text: value }] });

const when = (iso) => String(iso ?? '').slice(0, 10);

function renderResults(results, query) {
  if (!results.length) return `Nothing saved matches "${query}".`;
  return results.map((row, i) => [
    `${i + 1}. ${row.title}`,
    `   ${row.url}`,
    `   saved ${when(row.captured_at)} in "${row.space}" · matched on ${row.matched.join(' + ')}`,
    `   ${row.snippet.replace(/\s+/g, ' ').trim()}`,
  ].join('\n')).join('\n\n');
}

export function createMcpServer({ db, embed = null, version = '0.1.0' }) {
  const server = new McpServer({ name: 'magpie-local', version });

  server.registerTool('search_memories', {
    title: 'Search saved pages',
    description: 'Search the pages, PDFs and selections this person saved with magpie. '
      + 'Keyword and semantic search over their own reading, on their own machine. '
      + 'Use it whenever they refer to something they read, saved or remembered earlier.',
    inputSchema: {
      query: z.string().describe('What to look for, in the words a person would use.'),
      k: z.number().int().min(1).max(25).optional().describe('How many passages to return. Default 8.'),
      space: z.string().optional().describe('Restrict to one space, if they use more than one.'),
    },
  }, async ({ query, k = 8, space = null }) => {
    const results = await search(db, query, { k, space, embed });
    return text(renderResults(results, query));
  });

  server.registerTool('get_page', {
    title: 'Read one saved page',
    description: 'The full saved text of one page, by id or by URL. Use after search_memories '
      + 'when a passage looks right and the whole thing is needed.',
    inputSchema: {
      id: z.string().optional().describe('The page id from a search result.'),
      url: z.string().optional().describe('The original URL, if the id is not to hand.'),
      space: z.string().optional().describe('Which space the URL is in. Default "default".'),
    },
  }, async ({ id = null, url = null, space = 'default' }) => {
    const page = id ? getPage(db, id) : url ? getPageByUrl(db, space, url) : null;
    if (!page) return text('No saved page with that id or URL.');
    return text([
      page.title,
      page.url,
      `saved ${when(page.captured_at)} in "${page.space}"`,
      page.summary ? `\nSummary written on capture:\n${page.summary}` : '',
      '\n---\n',
      page.content,
    ].filter(Boolean).join('\n'));
  });

  server.registerTool('recent_memories', {
    title: 'Recently saved pages',
    description: 'What this person saved most recently, newest first. Use for "what was I reading" '
      + 'questions, or to see what is in the store before searching it.',
    inputSchema: {
      n: z.number().int().min(1).max(100).optional().describe('How many. Default 20.'),
      space: z.string().optional(),
    },
  }, async ({ n = 20, space = null }) => {
    const pages = recentPages(db, { limit: n, space });
    if (!pages.length) return text('Nothing saved yet.');
    return text(pages.map((page) =>
      `${when(page.captured_at)}  ${page.title}\n            ${page.url}`).join('\n'));
  });

  return server;
}

export async function serveStdio(options) {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
