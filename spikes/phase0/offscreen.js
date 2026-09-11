// S1/S2 probe. Holds an identity and a long-running job, entirely independent of
// the service worker. If the identity is stable across an SW death, S1 passes;
// if a job started before the death still completes and is readable after, S2 passes.

const INSTANCE_ID = crypto.randomUUID().slice(0, 8);
const BORN_AT = Date.now();
const jobs = new Map();

function startJob(jobId, durationMs) {
  const total = Math.ceil(durationMs / 1000);
  const job = { jobId, state: 'running', done: 0, total, startedAt: Date.now(), finishedAt: null };
  jobs.set(jobId, job);
  const timer = setInterval(() => {
    job.done += 1;
    if (job.done >= job.total) {
      clearInterval(timer);
      job.state = 'done';
      job.finishedAt = Date.now();
    }
  }, 1000);
  return job;
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'PING') {
    respond({ instanceId: INSTANCE_ID, uptimeMs: Date.now() - BORN_AT, jobs: jobs.size });
    return true;
  }
  if (msg.type === 'START_JOB') {
    respond(startJob(msg.jobId, msg.durationMs));
    return true;
  }
  if (msg.type === 'GET_STATE') {
    respond({ instanceId: INSTANCE_ID, job: jobs.get(msg.jobId) ?? null });
    return true;
  }
  return false;
});
