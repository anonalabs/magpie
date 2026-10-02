import { describe, it, expect } from 'vitest';
import { serviceFile, selfExec, LABEL, BUNDLE_ID } from '../src/service.js';
import { supportedNode } from '../src/quiet.js';

const base = { exec: '/usr/bin/node', args: ['/opt/magpie/local/src/cli.js', 'serve'], home: '/home/reader', port: 7777 };

describe('starting with the computer', () => {
  it('writes a systemd user unit on linux, pointing at this copy', () => {
    const plan = serviceFile({ ...base, platform: 'linux' });

    expect(plan.path).toBe('/home/reader/.config/systemd/user/magpie-local.service');
    expect(plan.contents).toContain('ExecStart=/usr/bin/node /opt/magpie/local/src/cli.js serve');
    expect(plan.contents).toContain('Environment=MAGPIE_PORT=7777');
    // A user unit, so it needs no root and starts at login
    expect(plan.contents).toContain('WantedBy=default.target');
    expect(plan.enable.map(([cmd]) => cmd)).toEqual(['systemctl', 'systemctl']);
  });

  it('quotes a path with a space rather than making two arguments of it', () => {
    const plan = serviceFile({ ...base, platform: 'linux', args: ['/home/a reader/cli.js', 'serve'] });
    expect(plan.contents).toContain('ExecStart=/usr/bin/node "/home/a reader/cli.js" serve');
  });

  it('writes a LaunchAgent on macOS', () => {
    const plan = serviceFile({ ...base, platform: 'darwin', logPath: '/home/reader/.magpie/magpie-local.log' });

    expect(plan.path).toBe(`/home/reader/Library/LaunchAgents/${BUNDLE_ID}.plist`);
    expect(plan.contents).toContain('<key>RunAtLoad</key>');
    expect(plan.contents).toContain('<string>/opt/magpie/local/src/cli.js</string>');
    expect(plan.contents).toContain('<string>/home/reader/.magpie/magpie-local.log</string>');
    expect(plan.enable[0]).toEqual(['launchctl', ['load', '-w', plan.path]]);
  });

  it('escapes a path that would otherwise break the plist', () => {
    const plan = serviceFile({ ...base, platform: 'darwin', args: ['/tmp/a&b/cli.js', 'serve'] });
    expect(plan.contents).toContain('<string>/tmp/a&amp;b/cli.js</string>');
    expect(plan.contents).not.toContain('<string>/tmp/a&b/cli.js</string>');
  });

  it('drops a command in the Startup folder on Windows, with nothing to run after', () => {
    const plan = serviceFile({ ...base, platform: 'win32' });

    expect(plan.path).toContain('Start Menu/Programs/Startup');
    expect(plan.path.endsWith(`${LABEL}.cmd`)).toBe(true);
    expect(plan.contents).toContain('start "" /b "/usr/bin/node"');
    expect(plan.contents).toContain('set MAGPIE_PORT=7777');
    expect(plan.enable).toEqual([]);
  });

  it('says so rather than guessing on a platform it does not know', () => {
    expect(serviceFile({ ...base, platform: 'aix' })).toBeNull();
  });
});

describe('how a service is told to run this copy', () => {
  it('names this node binary and the real script, never the shim', () => {
    // The shim begins `#!/usr/bin/env node`, and a service manager's PATH is
    // not a shell's: on this machine it found Node 18, which has no
    // node:sqlite, and the service failed forever on an unknown builtin.
    const { exec, args } = selfExec({
      argv: ['/nvm/v22/bin/node', '/nvm/v22/bin/magpie-local'],
      execPath: '/nvm/v22/bin/node',
      realpath: (p) => (p.endsWith('magpie-local') ? '/nvm/v22/lib/node_modules/@anona-labs/magpie-local/src/cli.js' : p),
    });

    expect(exec).toBe('/nvm/v22/bin/node');
    expect(args).toEqual(['/nvm/v22/lib/node_modules/@anona-labs/magpie-local/src/cli.js', 'serve']);
  });

  it('falls back to the path it was given when it cannot be resolved', () => {
    const { exec, args } = selfExec({
      argv: ['/usr/bin/node', '/gone/magpie-local'],
      execPath: '/usr/bin/node',
      realpath: () => { throw new Error('ENOENT'); },
    });
    expect(exec).toBe('/usr/bin/node');
    expect(args).toEqual(['/gone/magpie-local', 'serve']);
  });
});

describe('the Node it needs', () => {
  it('accepts 22.5 and newer, and nothing older', () => {
    expect(supportedNode('22.5.0')).toBe(true);
    expect(supportedNode('22.21.1')).toBe(true);
    expect(supportedNode('24.0.0')).toBe(true);
    // the version this actually failed on, in a systemd unit
    expect(supportedNode('18.20.6')).toBe(false);
    expect(supportedNode('22.4.1')).toBe(false);
    expect(supportedNode('20.11.0')).toBe(false);
  });
});
