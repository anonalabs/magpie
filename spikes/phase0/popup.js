const out = document.getElementById('out');
const log = (label, data) =>
  (out.textContent = `${label} @ ${new Date().toLocaleTimeString()}\n${JSON.stringify(data, null, 2)}`);

const send = (target, msg) => chrome.runtime.sendMessage({ target, ...msg });
const JOB_ID = 'spike-job';

document.getElementById('ensure').onclick = async () =>
  log('ENSURE_OFFSCREEN', await send('background', { type: 'ENSURE_OFFSCREEN' }));

// The S1/S2 probe: this goes popup -> offscreen with no background involvement.
document.getElementById('ping').onclick = async () =>
  log('PING (direct to offscreen)', await send('offscreen', { type: 'PING' }));

document.getElementById('job').onclick = async () =>
  log('START_JOB', await send('offscreen', { type: 'START_JOB', jobId: JOB_ID, durationMs: 90_000 }));

document.getElementById('state').onclick = async () =>
  log('GET_STATE', await send('offscreen', { type: 'GET_STATE', jobId: JOB_ID }));

document.getElementById('sw').onclick = async () =>
  log('SW_INFO', await send('background', { type: 'SW_INFO' }));
