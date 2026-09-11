import { describe, it, expect } from 'vitest';
import { isDeviceLost, isGpuFault } from '../src/lib/gpu.js';

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


describe('isGpuFault', () => {
  it('covers the mapAsync failure seen on an Intel Iris Xe', () => {
    // Verbatim from a real capture.
    expect(isGpuFault(new Error(
      "Failed to execute 'mapAsync' on 'GPUBuffer': Buffer was unmapped before mapping was resolved.",
    ))).toBe(true);
  });

  it('covers a lost device too — the engine is suspect either way', () => {
    expect(isGpuFault(new Error('vkQueueSubmit failed with VK_ERROR_DEVICE_LOST'))).toBe(true);
    expect(isGpuFault(new Error('Device was lost'))).toBe(true);
  });

  it('covers the other ways GPU state goes bad', () => {
    for (const text of [
      'GPUBuffer is destroyed',
      'Buffer is already mapped',
      'createBuffer failed: out of memory',
      'GPUQueue validation error',
    ]) expect(isGpuFault(new Error(text)), text).toBe(true);
  });

  it('does not claim failures that leave the engine perfectly usable', () => {
    // Rebuilding the engine for these would reload the model for nothing.
    for (const text of [
      'Failed to fetch',
      'The model returned an empty summary.',
      'Could not save the summary.',
      'This browser or GPU does not support WebGPU.',
    ]) expect(isGpuFault(new Error(text)), text).toBe(false);
  });

  it('is safe on nothing at all', () => {
    expect(isGpuFault(null)).toBe(false);
    expect(isGpuFault(undefined)).toBe(false);
  });
});
