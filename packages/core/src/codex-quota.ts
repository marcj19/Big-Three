import { spawn } from 'node:child_process';
import os from 'node:os';
import type { ResolvedCommand } from './command.js';
import type { QuotaWindow } from './types.js';
import { killTree } from './runner.js';
import { isRecord, num, str } from './adapters/base.js';

/** Official account/rateLimits/read response; never infer a subscription budget from token counts. */
export function parseCodexQuota(raw: unknown): QuotaWindow[] {
  if (!isRecord(raw)) return [];
  const buckets = isRecord(raw.rateLimitsByLimitId) && Object.keys(raw.rateLimitsByLimitId).length
    ? Object.entries(raw.rateLimitsByLimitId) : [['codex', raw.rateLimits]];
  const windows: QuotaWindow[] = [];
  for (const [id, value] of buckets) {
    if (!isRecord(value)) continue;
    for (const key of ['primary', 'secondary']) {
      const window = value[key];
      if (!isRecord(window)) continue;
      const usedPercent = num(window.usedPercent), minutes = num(window.windowDurationMins), reset = num(window.resetsAt);
      if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) continue;
      const duration = minutes === 10080 ? 'Semanal' : minutes && minutes % 60 === 0 ? `${minutes / 60} horas` : minutes ? `${minutes} minutos` : key === 'primary' ? 'Principal' : 'Secundária';
      windows.push({ name: `${str(value.limitName) ?? id} · ${duration}`, usedPercent,
        resetsAt: reset !== undefined && reset > 0 ? reset * 1000 : undefined, status: usedPercent >= 100 ? 'rejected' : 'allowed' });
    }
  }
  return windows;
}

/** Short-lived stdio connection. Only initializes and reads quotas; no thread or model turn is created. */
export function readCodexQuota(command: ResolvedCommand, env: NodeJS.ProcessEnv, timeoutMs = 15000): Promise<QuotaWindow[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.prefixArgs, 'app-server'], { cwd: os.homedir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', bytes = 0, done = false;
    const finish = (error?: Error, windows?: QuotaWindow[]) => {
      if (done) return;
      done = true; clearTimeout(timer); child.stdin.end(); void killTree(child);
      if (error) reject(error); else resolve(windows ?? []);
    };
    const timer = setTimeout(() => finish(new Error('Quota check timed out')), timeoutMs);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', () => finish(new Error('Codex app-server unavailable')));
    child.on('close', () => finish(new Error('Codex app-server closed before replying')));
    child.stdin.on('error', () => finish(new Error('Codex app-server input closed')));
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1000000) return finish(new Error('Quota response too large'));
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0 && !done) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg: unknown; try { msg = JSON.parse(line); } catch { continue; }
        if (!isRecord(msg)) continue;
        if (msg.id === 1) {
          if (msg.error || !('result' in msg)) return finish(new Error('Codex initialization failed'));
          send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' });
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error('Account quota unavailable'));
          finish(undefined, parseCodexQuota(msg.result));
        } else if ('id' in msg && typeof msg.method === 'string') {
          send({ id: msg.id, error: { code: -32601, message: 'Unsupported request' } });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'big_three', title: 'Big Three', version: '0.1.0' } } });
  });
}
