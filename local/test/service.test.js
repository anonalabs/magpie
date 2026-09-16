import { describe, it, expect } from 'vitest';
import { serviceFile, LABEL, BUNDLE_ID } from '../src/service.js';

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
