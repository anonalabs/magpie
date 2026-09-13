// Recognising a lost GPU device.
//
// WebGPU can take the device away mid-run: a compute shader that trips the
// driver's watchdog, memory pressure, a driver crash, a laptop waking from
// sleep. WebLLM surfaces no device-lost event, so the only signal is what the
// failure says, which makes this string matching, and therefore worth testing
// rather than trusting.
//
// It matters because the engine is cached across captures. A device that is
// gone stays gone, so a cached handle to one fails every later capture until the
// extension is reloaded. Recognising it is what allows the engine to be thrown
// away and rebuilt.

// Both orders, with a little room between the two words: the wording varies by
// driver and by browser version ("Device was lost", "lost the device",
// "device_lost"). Bounded, so it cannot span a whole sentence and match prose
// that merely mentions both words.
const SIGNS = [
  /\bdevice\b[\s_-]{0,3}(?:was |has been |is )?\blost\b/i,
  /\blost\b[\s_-]{0,3}(?:the |its )?\bdevice\b/i,
  /DEVICE_LOST/,            // VK_ERROR_DEVICE_LOST, DXGI_ERROR_DEVICE_LOST
  /vkQueueSubmit/i,         // Vulkan, which is what Chrome uses on Linux
  /device is destroyed/i,
  /GPUDevice.*destroyed/i,
];

export function isDeviceLost(error) {
  const text = String(error?.message ?? error ?? '');
  return SIGNS.some((sign) => sign.test(text));
}

/**
 * Faults that are not a lost device but leave the engine's GPU state suspect all
 * the same, a buffer unmapped underneath a pending read, an allocation refused,
 * a validation error on a resource the engine still believes it owns.
 *
 * Observed on an Intel Iris Xe: "Failed to execute 'mapAsync' on 'GPUBuffer':
 * Buffer was unmapped before mapping was resolved."
 */
const FAULTS = [
  /mapAsync/i,
  /unmapped|not mapped|already mapped/i,
  /GPUBuffer|GPUDevice|GPUQueue/,
  /out of memory|allocation failed|OOM/i,
  /createBuffer|destroyed/i,
];

/**
 * Whether the engine has to be thrown away and rebuilt.
 *
 * The distinction that matters is not what went wrong but whether the engine can
 * be trusted afterwards. It is cached across captures, so reusing one whose GPU
 * state is suspect turns a single fault into every later capture failing, which
 * is the shape of bug this has already produced twice.
 */
export function isGpuFault(error) {
  if (isDeviceLost(error)) return true;
  const text = String(error?.message ?? error ?? '');
  return FAULTS.some((fault) => fault.test(text));
}
