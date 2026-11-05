import { spawn, type ChildProcess } from 'node:child_process';
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

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // Model CLIs spawn their own children (tools, MCP servers); kill the whole tree.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } else {
    child.kill('SIGTERM');
  }
}

/** Runs a process and yields each non-empty stdout line. Throws CliExitError / CliAbortError. */
export async function* runProcess(inv: Invocation): AsyncGenerator<string, void> {
  const child = spawn(inv.command.file, [...inv.command.prefixArgs, ...inv.args], {
    cwd: inv.cwd,
    env: inv.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
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

  let abort: 'cancelled' | 'timeout' | undefined;
  const stop = (reason: 'cancelled' | 'timeout') => {
    abort ??= reason;
    killTree(child);
  };
  const onAbort = () => stop('cancelled');
  if (inv.signal?.aborted) onAbort();
  inv.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = inv.timeoutMs ? setTimeout(() => stop('timeout'), inv.timeoutMs) : undefined;

  child.stdin.on('error', () => {}); // EPIPE if the CLI exits before reading its prompt
  child.stdin.end(inv.stdin);

  try {
    child.stdout.setEncoding('utf8');
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim()) yield line;
    }
    const code = await exit;
    if (abort) throw new CliAbortError(abort);
    if (code !== 0) throw new CliExitError(code, stderr.trim());
  } finally {
    if (timer) clearTimeout(timer);
    inv.signal?.removeEventListener('abort', onAbort);
    killTree(child); // no-op when it has already exited; stops the process if the consumer quit early
  }
}
