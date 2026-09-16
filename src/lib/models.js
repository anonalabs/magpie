// The two models magpie offers, and everything that differs between them.
//
// Both are 4096-token context. That is the number that shapes the pipeline: a
// long article does not fit, so chunk-and-reduce is the ordinary path rather
// than a fallback for outliers.
//
// Note what is NOT here: the upstream CDN URL of each model library. Those are
// build-time only (scripts/fetch-wasm.mjs) and must never reach the shipped
// bundle: at runtime the library is loaded from inside the extension, and a CDN
// URL in the bundle is the thing scripts/check-no-remote-code.mjs exists to
// catch.

export const MODELS = {
  // For integrated graphics. Less than half the video memory of the next one up
  // and the same context window, which makes it the real answer to a GPU that
  // keeps faulting: those faults are almost always memory pressure, and a
  // retry does not reduce memory pressure.
  tiny: {
    id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    label: 'Tiny (Qwen2.5 0.5B)',
    note: 'lowest memory, for integrated graphics · ~950 MB',
    weightsUrl: 'https://huggingface.co/mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    libFile: 'Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm',
    vramMB: 944.62,
    lowResource: true,
    contextWindow: 4096,
  },
  small: {
    id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    label: 'Small (Qwen2.5 1.5B)',
    note: 'a good default · ~1.6 GB',
    weightsUrl: 'https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    libFile: 'Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm',
    vramMB: 1629.75,
    lowResource: true,
    contextWindow: 4096,
  },
  medium: {
    id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    label: 'Medium (Llama 3.2 3B)',
    note: 'best summaries, most memory · ~2.3 GB',
    weightsUrl: 'https://huggingface.co/mlc-ai/Llama-3.2-3B-Instruct-q4f16_1-MLC',
    libFile: 'Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm',
    vramMB: 2263.69,
    lowResource: true,
    contextWindow: 4096,
  },
};

export const DEFAULT_MODEL_SIZE = 'small';

/**
 * Gemma 3 1B was the tiny model and is not any more, at 711MB against 945.
 *
 * Its own config on HuggingFace declares `context_window_size: 8192` *and*
 * `sliding_window_size: 512`, and WebLLM refuses a model with both positive:
 * "Only one of context_window_size and sliding_window_size can be positive".
 * Every capture on it failed to load the engine at all.
 *
 * Either could be overridden to -1, and neither is safe to pick from here.
 * Disabling the sliding window asks for full attention from kernels compiled
 * for a model that does not work that way; keeping it means an attention window
 * of 512 tokens under a chunker that hands over three thousand, which is a
 * silently much worse summary rather than an error. A model that needs a
 * judgement call about its attention to work at all is the wrong model to put
 * behind the option people reach for when their GPU is already struggling.
 *
 * Qwen2.5 0.5B declares `sliding_window_size: -1`, is the same family as the
 * default so its output is consistent with it, and is still 40% of the memory.
 * `scripts/check-models.mjs` checks this property against the live configs,
 * because it is upstream's to change and it changed once already.
 */

/**
 * The next model down, for a GPU that is running out of room. Returns null at
 * the bottom, so a caller can tell "try smaller" from "there is nothing smaller".
 */
export function smallerThan(size) {
  const order = ['medium', 'small', 'tiny'];
  const next = order[order.indexOf(size) + 1];
  return next ?? null;
}

/**
 * A WebLLM appConfig for one model, built here rather than taken from
 * prebuiltAppConfig: importing that would pull ~150 entries into the bundle,
 * every one of them naming a .wasm on a CDN.
 */
export function appConfigFor(model, libUrl) {
  return {
    model_list: [{
      model: model.weightsUrl,
      model_id: model.id,
      model_lib: libUrl,
      vram_required_MB: model.vramMB,
      low_resource_required: model.lowResource,
      // Per model, because a sliding-window model has to say
      // `context_window_size: -1` instead, and WebLLM rejects both being
      // positive. Nothing here declares one today, and the check script is what
      // keeps that true.
      overrides: model.overrides ?? { context_window_size: model.contextWindow },
    }],
  };
}
