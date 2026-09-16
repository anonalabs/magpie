#!/usr/bin/env node
// Checks each model against its own config, upstream, right now.
//
// The failure this exists for, from real use: Gemma 3 1B's config on
// HuggingFace declares `context_window_size: 8192` and `sliding_window_size:
// 512`, both positive, and WebLLM refuses to build an engine for a model like
// that. magpie's override set `context_window_size` and could not win, so every
// capture on that model failed with a message about ModelRecord.overrides.
//
// None of it is visible from this repository: the config belongs to the model
// and can change without anything here changing. So this asks, over the
// network, and is deliberately not part of `npm test`, which must pass offline.
//
//   npm run check:models

import { MODELS } from '../src/lib/models.js';

const config = async (model) => {
  const url = `${model.weightsUrl}/resolve/main/mlc-chat-config.json`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};

let failed = false;
for (const [size, model] of Object.entries(MODELS)) {
  let cfg;
  try {
    cfg = await config(model);
  } catch (err) {
    console.log(`?  ${size.padEnd(7)} ${model.id}\n   could not read its config: ${err.message}`);
    failed = true;
    continue;
  }

  const sliding = cfg.sliding_window_size ?? -1;
  const context = cfg.context_window_size ?? -1;
  const overrides = model.overrides ?? { context_window_size: model.contextWindow };
  const positives = Object.entries({ ...{ context_window_size: context, sliding_window_size: sliding }, ...overrides })
    .filter(([, value]) => Number(value) > 0)
    .map(([key]) => key);

  if (positives.length > 1) {
    console.log(`x  ${size.padEnd(7)} ${model.id}`);
    console.log(`   its config has sliding_window_size ${sliding} and context_window_size ${context},`);
    console.log('   and WebLLM allows only one of them to be positive. Set the other to -1 in');
    console.log('   `overrides`, or use a model that does not need the judgement call.');
    failed = true;
    continue;
  }

  if (model.contextWindow > context && context > 0) {
    console.log(`x  ${size.padEnd(7)} ${model.id}`);
    console.log(`   magpie asks for a ${model.contextWindow}-token window; the model declares ${context}.`);
    failed = true;
    continue;
  }

  console.log(`ok ${size.padEnd(7)} ${model.id}  (context ${context}, sliding ${sliding})`);
}

console.log(failed ? '\nmodel check FAILED' : '\nevery model agrees with its own config');
process.exit(failed ? 1 : 0);
