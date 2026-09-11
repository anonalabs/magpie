#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_ORIGINS } from '../src/lib/providers/registry.js';
import { MODELS } from '../src/lib/models.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const watch = process.argv.includes('--watch');

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const manifest = {
  manifest_version: 3,
  name: 'magpie',
  version,
  description: 'Remember any page into your memory layer, distilled on your own machine.',
  minimum_chrome_version: '116',
  // activeTab, granted by clicking the action or pressing the shortcut, is why
  // there is no host permission for the pages you read.
  // alarms, because a retry has to survive the service worker being killed and
  // a timer inside it would not.
  permissions: ['activeTab', 'scripting', 'storage', 'offscreen', 'unlimitedStorage', 'alarms', 'contextMenus'],
  host_permissions: [
    ...PROVIDER_ORIGINS,
    // Model weights. Data, not code, so fetching them remotely is allowed;
    // the .wasm libraries are vendored (see scripts/fetch-wasm.mjs).
    'https://huggingface.co/*',
    'https://cdn-lfs.huggingface.co/*',
    'https://cdn-lfs-us-1.huggingface.co/*',
  ],
  // The floating in-page button asks for this at the moment it is switched on,
  // so the install prompt stays "no site access" for everyone who never does.
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  background: { service_worker: 'background.js', type: 'module' },
  action: { default_popup: 'popup.html', default_title: 'Remember this page' },
  icons: { 16: 'icons/16.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  commands: {
    'remember-page': {
      // NOT Ctrl/Cmd+Shift+M: Chrome reserves that for profile switching and
      // binds nothing, with no error. See spikes/phase0.
      suggested_key: { default: 'Alt+Shift+M', mac: 'Alt+Shift+M' },
      description: 'Remember this page',
    },
    'compose-capture': {
      suggested_key: { default: 'Alt+Shift+N', mac: 'Alt+Shift+N' },
      description: 'Remember this page with a note',
    },
  },
  content_security_policy: {
    // wasm-unsafe-eval is what lets the vendored model libraries compile. It is
    // the strongest policy under which WebAssembly runs at all in MV3.
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  web_accessible_resources: [],
};

const entries = {
  'background.js': { entry: join(SRC, 'background.js'), format: 'esm' },
  'offscreen.js': { entry: join(SRC, 'offscreen.js'), format: 'esm' },
  'popup.js': { entry: join(SRC, 'popup.js'), format: 'esm' },
  'permission.js': { entry: join(SRC, 'permission.js'), format: 'esm' },
  // Injected by executeScript, which runs a classic script.
  'content-script.js': { entry: join(SRC, 'content-script.js'), format: 'iife' },
  // Registered as a content script; also classic.
  'in-page.js': { entry: join(SRC, 'in-page.js'), format: 'iife' },
};

async function build() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  for (const [out, { entry, format }] of Object.entries(entries)) {
    await esbuild.build({
      entryPoints: [entry],
      outfile: join(DIST, out),
      bundle: true,
      format,
      target: 'chrome116',
      platform: 'browser',
      legalComments: 'inline',      // keeps Readability's MPL-2.0 header in the output
      minify: !watch,
      sourcemap: watch ? 'inline' : false,
    });
  }

  for (const file of ['popup.html', 'popup.css', 'offscreen.html', 'permission.html']) {
    cpSync(join(SRC, file), join(DIST, file));
  }

  const wasmDir = join(SRC, 'vendor/wasm');
  const missing = Object.values(MODELS).filter((m) => !existsSync(join(wasmDir, m.libFile)));
  if (missing.length) {
    throw new Error(
      `missing vendored model libraries: ${missing.map((m) => m.libFile).join(', ')}\n` +
      'run: npm run vendor:wasm',
    );
  }
  cpSync(wasmDir, join(DIST, 'wasm'), { recursive: true });
  cpSync(join(ROOT, 'icons'), join(DIST, 'icons'), { recursive: true });

  writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const total = readdirSync(DIST, { recursive: true })
    .map((f) => statSync(join(DIST, f)))
    .filter((s) => s.isFile())
    .reduce((sum, s) => sum + s.size, 0);
  console.log(`built dist/ (${(total / 1e6).toFixed(1)} MB)`);
}

if (watch) {
  await build();
  const { watch: fsWatch } = await import('node:fs');
  let pending = null;
  fsWatch(SRC, { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(() => build().then(() => console.log('rebuilt')).catch((e) => console.error(e.message)), 120);
  });
  console.log('watching src/ …');
} else {
  await build();
}
