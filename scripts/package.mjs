#!/usr/bin/env node
// Builds the zip that gets uploaded to the Chrome Web Store, and refuses to
// build it if anything in the package would be rejected on review.
//
// The checks here are the ones whose failure is expensive: they are found by a
// human reviewer days later, not by a build.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const ZIP = join(ROOT, `magpie-${version}.zip`);

if (!existsSync(DIST)) { console.error('no dist/ — run: npm run build'); process.exit(1); }

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const problems = [];

// Every file the manifest names must exist. A missing icon or page is an
// immediate rejection, and nothing else catches it.
const referenced = [
  ...Object.values(manifest.icons ?? {}),
  manifest.background?.service_worker,
  manifest.action?.default_popup,
].filter(Boolean);
for (const file of referenced) {
  if (!existsSync(join(DIST, file))) problems.push(`manifest names ${file}, which is not in dist/`);
}

if (!manifest.description) problems.push('no description — the store requires one');
if (manifest.description?.length > 132) problems.push(`description is ${manifest.description.length} chars; the store truncates at 132`);
if (!manifest.version?.match(/^\d+(\.\d+){0,3}$/)) problems.push(`version "${manifest.version}" is not store-legal`);

// Remotely-hosted code is the rejection this project is most exposed to.
try {
  execFileSync('node', [join(ROOT, 'scripts/check-no-remote-code.mjs')], { stdio: 'pipe' });
} catch (err) {
  problems.push('remote-code check failed — run: npm run check:remote');
}

const size = readdirSync(DIST, { recursive: true })
  .map((f) => statSync(join(DIST, f)))
  .filter((s) => s.isFile())
  .reduce((sum, s) => sum + s.size, 0);
if (size > 2_000_000_000) problems.push('package is over the store limit of 2 GB');

if (problems.length) {
  console.error('not packaging:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

rmSync(ZIP, { force: true });
// Zipped from inside dist/, because the store expects manifest.json at the root
// of the archive and not inside a folder.
execFileSync('zip', ['-qr', ZIP, '.'], { cwd: DIST });

console.log(`${ZIP.replace(ROOT + '/', '')}  (${(statSync(ZIP).size / 1e6).toFixed(1)} MB, ${(size / 1e6).toFixed(1)} MB unpacked)`);
console.log(`\nname        ${manifest.name}`);
console.log(`version     ${manifest.version}`);
console.log(`permissions ${manifest.permissions.join(', ')}`);
console.log(`hosts       ${manifest.host_permissions.length} required, ${(manifest.optional_host_permissions ?? []).length} optional`);
console.log('\nUpload at https://chrome.google.com/webstore/devconsole');
console.log('See docs/publishing.md for what the listing needs.');
