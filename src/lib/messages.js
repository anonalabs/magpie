// One message shape for the whole extension.
//
// Every extension context receives every runtime.sendMessage, so each message
// names its intended recipient and everyone else returns false immediately.
// Without that, two listeners answer one message and the first (arbitrary) reply
// wins.

export const TO_BACKGROUND = 'background';
export const TO_OFFSCREEN = 'offscreen';

export const MSG = {
  START_CAPTURE: 'START_CAPTURE',
  GET_CAPTURE_STATE: 'GET_CAPTURE_STATE',
  RUN_DISTILL: 'RUN_DISTILL',
  GET_JOB: 'GET_JOB',
  PRELOAD_MODEL: 'PRELOAD_MODEL',
  SYNC_IN_PAGE: 'SYNC_IN_PAGE',
  IN_PAGE_STATUS: 'IN_PAGE_STATUS',
  ENQUEUE: 'ENQUEUE',
  LIST_CAPTURES: 'LIST_CAPTURES',
  RETRY_CAPTURE: 'RETRY_CAPTURE',
  DELETE_CAPTURE: 'DELETE_CAPTURE',
  START_CAPTURE_FROM_PAGE: 'START_CAPTURE_FROM_PAGE',
  ENGINE_STATUS: 'ENGINE_STATUS',
};

export const toBackground = (type, payload = {}) =>
  chrome.runtime.sendMessage({ target: TO_BACKGROUND, type, ...payload });

export const toOffscreen = (type, payload = {}) =>
  chrome.runtime.sendMessage({ target: TO_OFFSCREEN, type, ...payload });

/**
 * Wraps an async handler in the callback shape chrome.runtime.onMessage wants:
 * return true synchronously, respond later. Returning the promise instead would
 * silently drop the reply.
 */
export function respondAsync(handler, respond) {
  handler().then(
    (result) => respond(result),
    (err) => respond({ ok: false, code: 'internal', message: String(err?.message ?? err) }),
  );
  return true;
}
