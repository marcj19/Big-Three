/**
 * Development only: serves the window in a normal browser against the same services the Electron app uses.
 * Listens on 127.0.0.1, refuses requests without the per-start token, and refuses other origins/hosts, because
 * anything that can reach this API can run your models.
 *
 *   AIO_DEMO=1 node dist/dev/server.js     fake models, no quota used
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from '@aio/db-broker';
import { AppService } from '../services/app-service.js';
import { API_METHODS, ATTACHMENT_TOTAL_LIMIT, type AppEvent } from '../shared/api.js';
import { demoAdapters } from './demo-adapters.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, '..', 'renderer');
const port = Number(process.env.AIO_WEB_PORT ?? 4173);
const token = randomBytes(24).toString('hex');
const origin = `http://127.0.0.1:${port}`;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json' };

const clients = new Set<http.ServerResponse>();
const broadcast = (event: AppEvent) => {
  for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
};

const service = new AppService({
  configDir: configDir(),
  adapters: process.env.AIO_DEMO === '1' ? demoAdapters() : undefined,
  emit: broadcast,
  // No native dialog here: writing is refused unless the person started this server saying they accept it.
  confirmAccess: async () => process.env.AIO_DEV_ALLOW_WRITE === '1',
});

const tokenOk = (given: string | undefined | null) => {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', origin);
  // Defends against DNS rebinding and cross-site requests to a local server.
  if (req.headers.host !== `127.0.0.1:${port}`) return void res.writeHead(403).end('Bad host');
  const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  try {
    if (url.pathname === '/events') {
      if (!tokenOk(url.searchParams.get('token'))) return void res.writeHead(403).end();
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
      if (req.headers.origin !== undefined && req.headers.origin !== origin) return send(403, { ok: false, error: 'Bad origin' });
      if (!tokenOk(req.headers['x-aio-token'] as string | undefined)) return send(403, { ok: false, error: 'Bad token' });
      const method = url.pathname.slice('/api/'.length);
      if (!(API_METHODS as readonly string[]).includes(method)) return send(404, { ok: false, error: 'Unknown method' });
      const limit = method === 'startRun' ? Math.ceil(ATTACHMENT_TOTAL_LIMIT / 3) * 4 + 1_000_000 : undefined;
      const { args } = JSON.parse((await readBody(req, limit)) || '{}') as { args?: unknown[] };
      const result = await (service[method as (typeof API_METHODS)[number]] as (...a: unknown[]) => Promise<unknown>)(...(Array.isArray(args) ? args : []));
      return send(200, { ok: true, result: result ?? null });
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(rendererDir, file);
    if (!full.startsWith(rendererDir + path.sep)) return void res.writeHead(403).end();
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream' }).end(body);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return void res.writeHead(404).end('Not found');
    if (!res.headersSent) send(500, { ok: false, error: err instanceof Error ? err.message : 'Failed' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Open ${origin}/#token=${token}`);
});
