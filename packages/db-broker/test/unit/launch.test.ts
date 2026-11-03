import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configDir, loadProfiles, saveProfiles, selectProfiles } from '../../src/config.js';
import { brokerServerSpec } from '../../src/launch.js';
import type { ConnectionProfile } from '../../src/types.js';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
const tmp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'aio-launch-'));
  dirs.push(d);
  return d;
};

const profile = (name: string): ConnectionProfile => ({ name, engine: 'postgres', host: 'h', port: 5432, database: 'd', user: 'u' });

describe('brokerServerSpec', () => {
  it('carries a folder and connection names, nothing secret', () => {
    const spec = brokerServerSpec({ configDir: 'C:\\cfg', connections: ['crm', 'erp'], entry: '/x/server.js' });
    expect(spec).toMatchObject({ name: 'db', command: process.execPath, args: ['/x/server.js'] });
    expect(spec.env).toEqual({ AIO_CONFIG_DIR: 'C:\\cfg', AIO_CONNECTIONS: 'crm,erp' });
    expect(JSON.stringify(spec)).not.toMatch(/AIO_SECRET|password/i);
  });

  it('omits the connection filter when every connection is allowed', () => {
    expect(brokerServerSpec({ configDir: '/c', entry: '/x/server.js' }).env).toEqual({ AIO_CONFIG_DIR: '/c' });
  });

  it('loads TypeScript entries through tsx', () => {
    const spec = brokerServerSpec({ configDir: '/c', entry: '/x/server.ts' });
    expect(spec.args[0]).toBe('--import');
    expect(spec.args.at(-1)).toBe('/x/server.ts');
  });
});

describe('configDir', () => {
  it('follows each platform\'s convention, and AIO_CONFIG_DIR wins', () => {
    expect(configDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me')).toBe(path.join('C:\\Users\\me\\AppData\\Roaming', 'ai-orchestrator'));
    expect(configDir({}, 'win32', '/home/me')).toBe(path.join('/home/me', 'AppData', 'Roaming', 'ai-orchestrator'));
    expect(configDir({}, 'darwin', '/Users/me')).toBe(path.join('/Users/me', 'Library', 'Application Support', 'ai-orchestrator'));
    expect(configDir({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux', '/home/me')).toBe(path.join('/x/cfg', 'ai-orchestrator'));
    expect(configDir({}, 'linux', '/home/me')).toBe(path.join('/home/me', '.config', 'ai-orchestrator'));
    expect(configDir({ AIO_CONFIG_DIR: '/custom', APPDATA: 'ignored' }, 'win32', '/h')).toBe('/custom');
  });
});

describe('selectProfiles', () => {
  const all = [profile('crm'), profile('erp'), profile('hr')];
  it('keeps everything without a filter', () => {
    expect(selectProfiles(all, undefined)).toHaveLength(3);
    expect(selectProfiles(all, '')).toHaveLength(3);
  });
  it('keeps only the named ones and ignores unknown names', () => {
    expect(selectProfiles(all, 'erp, nope').map((p) => p.name)).toEqual(['erp']);
  });
});

describe('saveProfiles', () => {
  it('round-trips through loadProfiles and fills the default port', async () => {
    const file = path.join(await tmp(), 'sub', 'connections.json');
    await saveProfiles([{ ...profile('crm'), port: undefined }], file);
    expect(await loadProfiles(file)).toEqual([{ ...profile('crm'), port: 5432 }]);
  });

  it('rejects duplicates and bad names without touching the existing file', async () => {
    const file = path.join(await tmp(), 'connections.json');
    await saveProfiles([profile('crm')], file);
    await expect(saveProfiles([profile('a'), profile('a')], file)).rejects.toThrow(/Duplicate/);
    await expect(saveProfiles([profile('../evil')], file)).rejects.toThrow();
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(1);
  });

  it('never writes a password field, even if one is smuggled in', async () => {
    const file = path.join(await tmp(), 'connections.json');
    await saveProfiles([{ ...profile('crm'), password: 'leak' } as ConnectionProfile], file);
    expect(await readFile(file, 'utf8')).not.toContain('leak');
  });
});
