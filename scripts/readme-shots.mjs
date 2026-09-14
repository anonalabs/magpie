#!/usr/bin/env node
// Regenerates the images the README uses, so the state in them is not folklore.
//
//   npm run build && node scripts/readme-shots.mjs
//
// Each shot seeds the extension's own storage and reloads the page, so what is
// photographed is the real popup rendering real state, not a mock of it.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shot = join(here, 'screenshot.mjs');

const SUMMARY = 'The chapter compares storage engines built on log-structured merge '
  + 'trees against those built on B-trees. LSM-trees write sequentially and compact in '
  + 'the background, giving higher write throughput; B-trees update pages in place, '
  + 'giving more predictable read latency.';

// A landed capture, as the popup shows it the moment after Remember.
const seedRemembered = `(async () => {
  const tab = await chrome.tabs.getCurrent();
  await chrome.storage.local.set({
    settings: {
      mode: 'distill', modelSize: 'small', providerId: 'anona',
      providers: { anona: { apiKey: 'anona_live_example', spaceId: 'reading' } },
    },
    captures: [{
      id: 'readme-shot', state: 'done', attempts: 0, nextAttemptAt: null, lastError: null,
      tabId: tab.id,
      title: 'Designing Data-Intensive Applications: Chapter 3',
      url: 'https://example.com/ddia/chapter-3',
      capturedAt: new Date().toISOString(), settledAt: Date.now(),
      mode: 'distill', sourceKind: 'page', kind: 'summary', chars: ${JSON.stringify(SUMMARY)}.length,
      providerId: 'anona',
      destinationConfig: { spaceId: 'reading' },
      destination: 'Anona Memory \\u00b7 reading',
      summary: ${JSON.stringify(SUMMARY)},
      key: 'anona:https://example.com/ddia/chapter-3',
    }],
  });
  setTimeout(() => location.reload(), 50);
})()`;

// activeTab gives the popup the page's title and URL only when the toolbar
// button opened it. Nothing clicks a toolbar button here, so the heading would
// read "This page" with no host: true of this harness, not of the product.
const stagePage = `
  document.getElementById('page-title').textContent =
    'Designing Data-Intensive Applications: Chapter 3';
  document.getElementById('page-url').textContent = 'example.com';
`;

const shots = [
  {
    out: 'docs/media/popup.png', page: 'popup.html', scheme: 'light', width: '400',
    script: seedRemembered, after: stagePage,
  },
];

for (const { out, page, scheme, width, script, after = '' } of shots) {
  const run = spawnSync(process.execPath, [shot, out, page, scheme, width, script, after], { stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
