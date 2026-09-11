#!/usr/bin/env node
// Vendors the model libraries into the extension.
//
// WebLLM points model_lib at raw.githubusercontent.com. Chrome counts a remotely
// fetched .wasm as remotely-hosted code, which is a flat Web Store rejection, so
// the libs have to ship inside the package and model_lib has to be rewritten to
// chrome.runtime.getURL(). Model *weights* stay remote: those are data, not code.
//
// The fetched files are committed, so a build never depends on GitHub being up
// and the shipped bytes are the reviewed bytes.

import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../src/lib/models.js';

// Build-time only. Deliberately not in src/: a CDN .wasm URL in the shipped
// bundle is the exact thing that makes the extension unpublishable.
const LIB_PREFIX = 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/vendor/wasm');
mkdirSync(OUT, { recursive: true });

let failed = false;
for (const model of Object.values(MODELS)) {
  const dest = join(OUT, model.libFile);
  if (existsSync(dest) && !process.argv.includes('--force')) {
    console.log(`have  ${model.libFile} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
    continue;
  }
  process.stdout.write(`fetch ${model.libFile} ... `);
  const res = await fetch(LIB_PREFIX + model.libFile);
  if (!res.ok) { console.log(`FAILED ${res.status}`); failed = true; continue; }
  const bytes = Buffer.from(await res.arrayBuffer());
  // A GitHub error page is a 200 with HTML in it; a wasm module starts \0asm.
  if (bytes.subarray(0, 4).toString('binary') !== '\0asm') {
    console.log('FAILED — not a WebAssembly module');
    failed = true;
    continue;
  }
  writeFileSync(dest, bytes);
  console.log(`${(bytes.length / 1e6).toFixed(1)} MB`);
}
process.exit(failed ? 1 : 0);
