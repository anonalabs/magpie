#!/usr/bin/env node
// Fails the build if anything in dist/ would fetch executable code at runtime.
//
// This is the Web Store rejection that is easiest to reintroduce by accident:
// one WebLLM upgrade that resets model_lib, or one import rewritten to a CDN,
// and the extension still works perfectly in development while being
// unpublishable. Cheap to check, expensive to discover at submission.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '../dist');

// Hosts that may legitimately appear: they serve model *weights*, which are
// data. Anything else that looks like a code fetch is a failure.
const ALLOWED = [
  'https://huggingface.co',
  'https://cdn-lfs.huggingface.co',
  'https://cdn-lfs-us-1.huggingface.co',
  'https://api.anonalabs.com',
  'https://api.mem0.ai',
  'https://api.supermemory.ai',
];

// Hosts that appear only as text a human might click — never fetched. Each one
// is listed deliberately; an unexplained host is a finding, not a nuisance.
const INFORMATIONAL = [
  'https://webgpureport.org',        // in WebLLM's "your GPU is unsupported" message
  // WebLLM's own modelLibURLPrefix constant. It is a bare prefix with no
  // filename and is only used to assemble prebuiltAppConfig, which magpie never
  // imports (see src/lib/models.js appConfigFor). Any concrete .wasm URL on this
  // host still fails below, and the manifest grants no host permission for it,
  // so a fetch would be refused at runtime even if one were somehow assembled.
  'https://raw.githubusercontent.com',
];

const CODE_EXT = /\.(wasm|js|mjs|cjs)(\?|$)/i;

const files = readdirSync(DIST, { recursive: true })
  .map((f) => join(DIST, f))
  .filter((f) => statSync(f).isFile() && ['.js', '.html', '.json', '.css'].includes(extname(f)));

const findings = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const url of text.match(/https?:\/\/[^\s"'`)\\]+/g) ?? []) {
    let parsed;
    try { parsed = new URL(url); } catch { continue; }

    // Chrome match patterns ("http://*/*") parse as URLs but address nothing —
    // they are permission and content-script declarations, and cannot fetch.
    if (parsed.hostname.includes('*')) continue;

    const origin = parsed.origin;
    if (INFORMATIONAL.includes(origin) && !CODE_EXT.test(url)) continue;
    if (ALLOWED.includes(origin) && !CODE_EXT.test(url)) continue;
    if (CODE_EXT.test(url)) findings.push({ file: file.replace(DIST, 'dist'), url, why: 'remotely-hosted code' });
    else if (!ALLOWED.includes(origin)) findings.push({ file: file.replace(DIST, 'dist'), url, why: 'unexpected host' });
  }
}

if (findings.length === 0) {
  console.log(`no remote code in dist/ (${files.length} files scanned)`);
  process.exit(0);
}

console.error('remote-code check FAILED:\n');
for (const f of findings) console.error(`  ${f.why}\n    ${f.url}\n    in ${f.file}\n`);
process.exit(1);
