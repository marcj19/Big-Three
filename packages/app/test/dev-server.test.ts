import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tmp } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 41_000 + Math.floor(Math.random() * 2_000);
let child: ChildProcess;
let token = '';

/** Raw request, so the Host header and the path can be set to what an attacker's page would produce. */
function raw(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers, setHost: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
const call = (method: string, headers: Record<string, string> = {}) =>
  raw({ method: 'POST', path: `/api/${method}`, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers }, body: '{"args":[]}' });

beforeAll(async () => {
  const configDir = await tmp();
  child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(root, 'src', 'dev', 'server.ts')], {
    env: { ...process.env, AIO_DEMO: '1', AIO_WEB_PORT: String(port), AIO_CONFIG_DIR: configDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server did not start')), 20_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      const m = /#token=([0-9a-f]+)/.exec(chunk.toString());
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
  });
}, 30_000);

afterAll(() => {
  child?.kill();
});

describe('dev server (anything that reaches it can run your models)', () => {
  it('answers a call that carries the token', async () => {
    const r = await call('providersStatus', { 'x-aio-token': token });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, result: [{ id: 'claude' }, { id: 'gemini' }, { id: 'codex' }] });
  });

  it('refuses a missing or wrong token', async () => {
    expect((await call('providersStatus')).status).toBe(403);
    expect((await call('providersStatus', { 'x-aio-token': 'f'.repeat(token.length) })).status).toBe(403);
    expect((await call('providersStatus', { 'x-aio-token': 'short' })).status).toBe(403);
  });

  it('refuses another origin even with the token (a web page in another tab)', async () => {
    expect((await call('providersStatus', { 'x-aio-token': token, origin: 'https://evil.example' })).status).toBe(403);
  });

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    const r = await raw({ method: 'POST', path: '/api/providersStatus', headers: { host: 'evil.example', 'x-aio-token': token } });
    expect(r.status).toBe(403);
    expect((await raw({ path: '/', headers: { host: 'evil.example' } })).status).toBe(403);
  });

  it('only accepts POST and known methods', async () => {
    expect((await raw({ path: '/api/providersStatus', headers: { host: `127.0.0.1:${port}`, 'x-aio-token': token } })).status).toBe(405);
    expect((await call('constructor', { 'x-aio-token': token })).status).toBe(404);
    expect((await call('__proto__', { 'x-aio-token': token })).status).toBe(404);
  });

  it('protects the event stream with the token too', async () => {
    expect((await raw({ path: '/events', headers: { host: `127.0.0.1:${port}` } })).status).toBe(403);
  });

  it('serves the window but nothing outside its folder', async () => {
    const home = await raw({ path: '/', headers: { host: `127.0.0.1:${port}` } });
    expect(home.status).toBe(200);
    expect(home.body).toContain('Content-Security-Policy');
    for (const p of ['/../../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json']) {
      const r = await raw({ path: p, headers: { host: `127.0.0.1:${port}` } });
      expect(r.status, p).not.toBe(200);
    }
  });
});
