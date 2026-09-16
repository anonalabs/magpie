import { describe, it, expect } from 'vitest';
import { MODELS, DEFAULT_MODEL_SIZE, appConfigFor, smallerThan } from '../src/lib/models.js';

describe('the models on offer', () => {
  it('never asks WebLLM for two positive window sizes', () => {
    // The failure this pins: a model whose own config declares a sliding window
    // AND a context window cannot be given a positive override for the other,
    // and the engine refuses to build at all. scripts/check-models.mjs checks
    // the live configs; this checks what magpie itself sends.
    for (const [size, model] of Object.entries(MODELS)) {
      const { overrides } = appConfigFor(model, 'chrome-extension://x/lib.wasm').model_list[0];
      const positive = Object.values(overrides).filter((v) => Number(v) > 0);
      expect(positive.length, `${size} sends ${JSON.stringify(overrides)}`).toBe(1);
    }
  });

  it('points model_lib inside the extension, never at a CDN', () => {
    const config = appConfigFor(MODELS.small, 'chrome-extension://abc/vendor/wasm/lib.wasm');
    expect(config.model_list[0].model_lib).toBe('chrome-extension://abc/vendor/wasm/lib.wasm');
  });

  it('orders the sizes so a struggling GPU has somewhere to go', () => {
    expect(smallerThan('medium')).toBe('small');
    expect(smallerThan('small')).toBe('tiny');
    expect(smallerThan('tiny')).toBeNull();
    expect(MODELS.tiny.vramMB).toBeLessThan(MODELS.small.vramMB);
    expect(MODELS.small.vramMB).toBeLessThan(MODELS.medium.vramMB);
  });

  it('has a default that exists', () => {
    expect(MODELS[DEFAULT_MODEL_SIZE]).toBeDefined();
  });

  it('vendors a library file for every model', () => {
    for (const model of Object.values(MODELS)) {
      expect(model.libFile).toMatch(/\.wasm$/);
      expect(model.weightsUrl).toMatch(/^https:\/\/huggingface\.co\//);
    }
  });
});
