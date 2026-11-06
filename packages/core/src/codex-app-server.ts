import { spawn } from 'node:child_process';
import os from 'node:os';
import { isRecord, str } from './adapters/base.js';
import type { ResolvedCommand } from './command.js';
import { killTree } from './runner.js';

/** Short-lived stdio connection for read-only queries. No thread or model turn is created. */
export function readCodexAppServer(
  command: ResolvedCommand,
  env: NodeJS.ProcessEnv,
  method: 'account/rateLimits/read' | 'model/list',
  timeoutMs = 15_000,
): Promise<unknown[]> {
  const models = method === 'model/list';
  const unavailable = models ? 'Codex model catalog unavailable' : 'Account quota unavailable';
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.prefixArgs, 'app-server'], {
      cwd: os.homedir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pages: unknown[] = [];
    const cursors = new Set<string>();
    let buffer = '', bytes = 0, done = false, requestId = 1;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      void killTree(child);
      if (error) reject(error); else resolve(pages);
    };
    const timer = setTimeout(() => finish(new Error('Codex app-server request timed out')), timeoutMs);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (cursor?: string) => send({
      id: ++requestId, method,
      ...(models ? { params: { limit: 20, includeHidden: false, ...(cursor ? { cursor } : {}) } } : {}),
    });
    child.on('error', () => finish(new Error('Codex app-server unavailable')));
    child.on('close', () => finish(new Error('Codex app-server closed before replying')));
    child.stdin.on('error', () => finish(new Error('Codex app-server input closed')));
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1_000_000) return finish(new Error('Codex app-server response too large'));
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0 && !done) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg: unknown; try { msg = JSON.parse(line); } catch { continue; }
        if (!isRecord(msg)) continue;
        if (typeof msg.method === 'string') {
          if ('id' in msg) send({ id: msg.id, error: { code: -32601, message: 'Unsupported request' } });
        } else if (msg.id === requestId) {
          if (requestId === 1) {
            if (msg.error || !('result' in msg)) return finish(new Error('Codex initialization failed'));
            send({ method: 'initialized' });
            request();
          } else {
            if (msg.error || !('result' in msg)) return finish(new Error(unavailable));
            pages.push(msg.result);
            const cursor = models && isRecord(msg.result) ? str(msg.result.nextCursor) : undefined;
            if (!cursor) return finish();
            if (cursors.has(cursor)) return finish(new Error(unavailable));
            cursors.add(cursor);
            request(cursor);
          }
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'big_three', title: 'Big Three', version: '0.1.0' } } });
  });
}
