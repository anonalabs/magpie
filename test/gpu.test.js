import { describe, it, expect } from 'vitest';
import { isDeviceLost } from '../src/lib/gpu.js';

describe('isDeviceLost', () => {
  it('recognises the Vulkan failure Chrome reports on Linux', () => {
    // Verbatim from a real Intel Iris Xe reset.
    expect(isDeviceLost(new Error(
      'vkQueueSubmit failed with VK_ERROR_DEVICE_LOST - While handling unexpected '
      + 'error type DeviceLost when allowed errors are Validation.',
    ))).toBe(true);
  });

  it('recognises the other ways a device goes away', () => {
    for (const text of [
      'Device was lost',
      'GPUDevice is destroyed',
      'The device is destroyed',
      'WebGPU lost the device',
      'DXGI_ERROR_DEVICE_LOST',
    ]) expect(isDeviceLost(new Error(text)), text).toBe(true);
  });

  it('takes a bare string as well as an Error', () => {
    expect(isDeviceLost('VK_ERROR_DEVICE_LOST')).toBe(true);
  });

  it('does not fire on failures that are not a lost device', () => {
    // These have their own recoveries; treating them as a device loss would
    // throw away a perfectly good engine and reload 1.1 GB for nothing.
    for (const text of [
      'Model not loaded before trying to complete ChatCompletionRequest',
      'Failed to fetch',
      'out of memory',
      'This browser or GPU does not support WebGPU.',
      'The model returned an empty summary.',
    ]) expect(isDeviceLost(new Error(text)), text).toBe(false);
  });

  it('is safe on nothing at all', () => {
    expect(isDeviceLost(null)).toBe(false);
    expect(isDeviceLost(undefined)).toBe(false);
    expect(isDeviceLost({})).toBe(false);
  });
});
