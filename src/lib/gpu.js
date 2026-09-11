// Recognising a lost GPU device.
//
// WebGPU can take the device away mid-run: a compute shader that trips the
// driver's watchdog, memory pressure, a driver crash, a laptop waking from
// sleep. WebLLM surfaces no device-lost event, so the only signal is what the
// failure says — which makes this string matching, and therefore worth testing
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
