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
  // Where each memory layer's account and API key live. These are `href`s and
  // link text in the popup, shown to a reader who has no key yet; nothing in
  // the extension fetches them. The API hosts they pair with are in ALLOWED
  // above, and a code URL on any of these still fails below.
  'https://memory.anonalabs.com',
  'https://mem0.ai',
  'https://app.mem0.ai',
  'https://supermemory.ai',
  'https://console.supermemory.ai',
  // WebLLM's own modelLibURLPrefix constant. It is a bare prefix with no
  // filename and is only used to assemble prebuiltAppConfig, which magpie never
  // imports (see src/lib/models.js appConfigFor). Any concrete .wasm URL on this
  // host still fails below, and the manifest grants no host permission for it,
  // so a fetch would be refused at runtime even if one were somehow assembled.
  'https://raw.githubusercontent.com',
];

// XML namespaces are URIs by convention and are never dereferenced — they are
// identifiers that happen to be spelled like addresses. A vendored parser is
// full of them, and failing on those would mean either deleting this check or
// ignoring it, which are the same thing.
const NAMESPACE_HOSTS = new Set([
  'www.w3.org', 'ns.adobe.com', 'www.xfa.org',
  'purl.org', 'iptc.org', 'example.com', 'foo.bar',   // pdf.js sample and spec strings
  'github.com',                                       // core-js license notice, shipped in its polyfills
  'a', 'b', 'x',                                      // core-js URL-parser conformance strings
]);

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
    // A template placeholder is not an address; it is assembled at runtime and
    // cannot be judged from here. The code-extension rule below still applies.
    if (url.includes('${')) continue;
    if (NAMESPACE_HOSTS.has(parsed.hostname) && !CODE_EXT.test(url)) continue;

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
