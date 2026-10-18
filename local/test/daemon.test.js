import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A daemon we did not start: it answers /health on the port, and there is no
// pid file of ours beside it. That is precisely what `magpie-local install`
// leaves behind — the service manager execs `serve` itself — and it is also
// another checkout, or a second copy somebody left running.
const stranger = (health) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});

/** daemon.js reads its home at import, so each case gets its own. */
async function daemonIn(home) {
  process.env.MAGPIE_HOME = home;
  vi.resetModules();
  return import('../src/daemon.js');
}

const scratch = () => mkdtempSync(join(tmpdir(), 'magpie-daemon-'));

let open = [];
afterEach(async () => {
  for (const server of open) await new Promise((r) => server.close(r));
  open = [];
  delete process.env.MAGPIE_HOME;
});

describe('a daemon we did not start', () => {
  it('is not mistaken for our own, however healthy it is', async () => {
    const server = await stranger({ ok: true, name: 'magpie-local', version: '0.0.1' });
    open.push(server);
    const port = server.address().port;

    const home = scratch();
    const { healthy, start, PID_PATH } = await daemonIn(home);

    // The control: the port really does answer, and answers well. This is the
    // reading that `start` used to accept as proof its own child had come up.
    expect(await healthy(port)).toMatchObject({ ok: true, version: '0.0.1' });

    const result = await start({ port, wait: 500 });
    expect(result).toMatchObject({ foreign: true });
    expect(result.health.version).toBe('0.0.1');
    // No claim of a start, so no pid to report and nothing written down.
    expect(result.pid).toBeUndefined();
    expect(result.already).toBeUndefined();
    expect(existsSync(PID_PATH)).toBe(false);
  });

  it('is reported by stop, rather than called not running', async () => {
    const server = await stranger({ ok: true, name: 'magpie-local', version: '0.0.1' });
    open.push(server);
    const port = server.address().port;

    const { stop } = await daemonIn(scratch());

    const result = await stop({ port, wait: 200 });
    // It said `not running` and killed nothing, which is what made `restart`
    // a no-op against an installed service.
    expect(result).toMatchObject({ foreign: true });
    expect(result.health.version).toBe('0.0.1');
  });

  it('is told apart from nothing running at all', async () => {
    const { stop, foreign } = await daemonIn(scratch());
    // Port 1 is privileged and nothing of ours is on it.
    expect(await foreign(1)).toBeNull();
    expect(await stop({ port: 1, wait: 100 })).toEqual({ wasRunning: false });
  });
});
