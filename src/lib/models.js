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
    id: 'gemma3-1b-it-q4f16_1-MLC',
    label: 'Tiny (Gemma 3 1B)',
    note: 'lowest memory, for integrated graphics · ~700 MB',
    weightsUrl: 'https://huggingface.co/mlc-ai/gemma3-1b-it-q4f16_1-MLC',
    libFile: 'gemma3-1b-it-q4f16_1_cs1k-webgpu.wasm',
    vramMB: 711.07,
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
      overrides: { context_window_size: model.contextWindow },
    }],
  };
}
