import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { ResolvedCommand } from './command.js';

export interface Invocation {
  command: ResolvedCommand;
  args: string[];
  /** Written to the process's stdin, which is then closed. Prompts go here, never on the command line. */
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class CliExitError extends Error {
  constructor(
    readonly code: number | null,
    readonly stderrTail: string,
  ) {
    super(`CLI exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`);
    this.name = 'CliExitError';
  }
}

export class CliAbortError extends Error {
  constructor(readonly reason: 'cancelled' | 'timeout') {
    super(reason === 'timeout' ? 'The CLI timed out' : 'Cancelled');
    this.name = 'CliAbortError';
  }
}

const STDERR_LIMIT = 4_000;

export async function killTree(child: ChildProcess, group = false): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (group && process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGTERM'); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { process.kill(-pid, 'SIGKILL'); } catch { /* The group already exited. */ }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const command = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe';
    await new Promise<void>((resolve) => {
      const killer = spawn(command, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      };
      const timer = setTimeout(() => { killer.kill(); finish(false); }, 3_000);
      killer.once('error', () => finish(false));
      killer.once('exit', (code) => finish(code === 0));
    });
  } else {
    child.kill('SIGTERM');
  }
}

/** Runs a process and yields each non-empty stdout line. Throws CliExitError / CliAbortError. */
export async function* runProcess(inv: Invocation): AsyncGenerator<string, void> {
  if (inv.signal?.aborted) throw new CliAbortError('cancelled');
  const child = spawn(inv.command.file, [...inv.command.prefixArgs, ...inv.args], {
    cwd: inv.cwd,
    env: inv.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    shell: false,
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_LIMIT);
  });

  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  exit.catch(() => {}); // surfaced below; avoids an unhandled rejection if the consumer stops early

  child.stdout.setEncoding('utf8');
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let abort: 'cancelled' | 'timeout' | undefined;
  let termination: Promise<void> | undefined;
  let interrupt!: (value: null) => void;
  const interrupted = new Promise<null>((resolve) => { interrupt = resolve; });
  const stop = (reason: 'cancelled' | 'timeout') => {
    if (abort) return;
    abort = reason;
    termination = killTree(child, true);
    lines.close();
    child.stdout.destroy();
    child.stderr.destroy();
    interrupt(null);
  };
  const onAbort = () => stop('cancelled');
  if (inv.signal?.aborted) onAbort();
  inv.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = inv.timeoutMs ? setTimeout(() => stop('timeout'), inv.timeoutMs) : undefined;

  child.stdin.on('error', () => {}); // EPIPE if the CLI exits before reading its prompt
  child.stdin.end(inv.stdin);

  try {
    for await (const line of lines) {
      if (abort) break;
      if (line.trim()) yield line;
    }
    const code = await Promise.race([exit, interrupted]);
    if (abort) throw new CliAbortError(abort);
    if (code !== 0) throw new CliExitError(code, stderr.trim());
  } finally {
    if (timer) clearTimeout(timer);
    inv.signal?.removeEventListener('abort', onAbort);
    await (termination ?? killTree(child)); // also stops a process if the consumer quit early
  }
}
