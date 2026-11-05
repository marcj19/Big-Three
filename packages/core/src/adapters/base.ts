import os from 'node:os';
import { resolveCommand, type ResolvedCommand } from '../command.js';
import { sanitizeEnv } from '../env.js';
import { CliAbortError, CliExitError, runProcess } from '../runner.js';
import type { AgentEvent, Adapter, AuthStatus, Availability, LoginEvent, ModelOption, ProviderId, RunRequest } from '../types.js';

export interface AdapterOptions {
  /** Explicit executable path; skips PATH search. */
  executablePath?: string;
  /** Pre-resolved command (mainly for tests). */
  command?: ResolvedCommand;
  /** Sensitive-looking env vars the CLI genuinely needs, e.g. CLAUDE_CODE_OAUTH_TOKEN. */
  passthroughEnv?: string[];
  /** Debug tap: receives every stdout line exactly as the CLI printed it. */
  onRawLine?: (line: string) => void;
}

export interface BuiltInvocation {
  args: string[];
  stdin: string;
  /** Removes temp files created for this run. */
  cleanup?: () => Promise<void>;
}

export type Parser = (raw: unknown) => AgentEvent[];

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const DEFAULT_MODEL: ModelOption = { id: '', label: 'Padrão da conta' };

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const SAFE_EFFORT = /^[a-z]{3,10}$/;

/**
 * Model and effort end up as command-line arguments. They are never run through a shell, but a value starting with
 * "-" would still be read by the CLI as another option, so anything unusual is refused before it gets there.
 */
export function assertSafeChoice(req: Pick<RunRequest, 'model' | 'effort'>): void {
  if (req.model !== undefined && req.model !== '' && !SAFE_MODEL.test(req.model)) throw new Error(`Invalid model name: ${req.model.slice(0, 40)}`);
  if (req.effort !== undefined && req.effort !== '' && !SAFE_EFFORT.test(req.effort)) throw new Error(`Invalid effort: ${req.effort.slice(0, 20)}`);
}

const AUTH_FAILURE =/not logged in|\/login|authenticat|unauthori[sz]ed|\b401\b/i;

/** CLIs report a signed-out state in different, noisy ways (stack traces, banners); say what the user must do. */
export function friendlyError(displayName: string, message: string): string {
  if (AUTH_FAILURE.test(message)) {
    return `${displayName} is not signed in. Open a terminal, run the ${displayName} CLI once and sign in with your account, then try again.`;
  }
  return message;
}

export abstract class CliAdapter implements Adapter {
  abstract readonly id: ProviderId;
  abstract readonly displayName: string;
  abstract readonly supportsResume: boolean;
  abstract readonly supportsMcp: boolean;
  readonly efforts: readonly string[] = [];
  protected abstract readonly binaryName: string;
  protected abstract readonly installHint: string;
  /** Extra folders to look in when the CLI is not on PATH. */
  protected readonly extraSearchDirs: string[] = [];

  constructor(protected readonly opts: AdapterOptions = {}) {}

  protected abstract build(req: RunRequest): Promise<BuiltInvocation> | BuiltInvocation;
  /** Returns a fresh stateful parser for one run. */
  protected abstract createParser(): Parser;

  protected command(): Promise<ResolvedCommand> {
    return this.opts.command
      ? Promise.resolve(this.opts.command)
      : resolveCommand(this.binaryName, { explicitPath: this.opts.executablePath, extraDirs: this.extraSearchDirs });
  }

  protected env(): NodeJS.ProcessEnv {
    return sanitizeEnv(process.env, { passthrough: this.opts.passthroughEnv });
  }

  /** Arguments of the CLI's own sign-in command, if it has one. */
  protected readonly loginArgs: string[] | undefined = undefined;
  /** What to tell the user when sign-in cannot be started from the app. */
  protected readonly loginHelp: string = 'Open a terminal, run the CLI once and sign in.';

  get canLogin(): boolean {
    return this.loginArgs !== undefined;
  }

  /** Subclasses return what their CLI offers. */
  async listModels(): Promise<ModelOption[]> {
    return [DEFAULT_MODEL];
  }

  /** Cheap, quota-free check. Subclasses override; the default cannot tell. */
  protected async checkAuth(): Promise<AuthStatus> {
    return { signedIn: 'unknown' };
  }

  /** Runs a short CLI command and returns its stdout lines and exit code (null if it could not start). */
  protected async capture(args: string[]): Promise<{ lines: string[]; code: number | null; stderr?: string }> {
    const lines: string[] = [];
    try {
      const command = await this.command();
      for await (const line of runProcess({ command, args, stdin: '', cwd: process.cwd(), env: this.env(), timeoutMs: 20_000 })) lines.push(line);
      return { lines, code: 0 };
    } catch (err) {
      return err instanceof CliExitError ? { lines, code: err.code, stderr: err.stderrTail } : { lines, code: null };
    }
  }

  async authStatus(): Promise<AuthStatus> {
    if (!(await this.detect()).available) return { signedIn: false, detail: 'CLI not installed' };
    return this.checkAuth();
  }

  async *login(signal?: AbortSignal): AsyncGenerator<LoginEvent, void> {
    if (!this.loginArgs) {
      yield { type: 'done', ok: false, message: this.loginHelp };
      return;
    }
    try {
      const command = await this.command();
      // The CLI opens the browser itself; its output (e.g. a fallback URL) is relayed for the UI to show.
      for await (const line of runProcess({ command, args: this.loginArgs, stdin: '', cwd: os.homedir(), env: this.env(), signal, timeoutMs: 300_000 })) {
        yield { type: 'output', line };
      }
      const status = await this.checkAuth();
      yield { type: 'done', ok: status.signedIn === true, message: status.signedIn === true ? undefined : 'Sign-in did not complete.' };
    } catch (err) {
      const cancelled = err instanceof CliAbortError;
      yield { type: 'done', ok: false, message: cancelled ? 'Sign-in cancelled.' : friendlyError(this.displayName, (err as Error).message) };
    }
  }

  async detect(): Promise<Availability> {
    let command: ResolvedCommand;
    try {
      command = await this.command();
    } catch {
      return { available: false, reason: `${this.displayName} CLI not found. ${this.installHint}` };
    }
    try {
      let first = '';
      for await (const line of runProcess({ command, args: ['--version'], stdin: '', cwd: process.cwd(), env: this.env(), timeoutMs: 20_000 })) {
        first ||= line.trim();
      }
      return { available: true, version: first || undefined };
    } catch (err) {
      return { available: false, reason: `${this.displayName} CLI failed to start: ${(err as Error).message}` };
    }
  }

  async *run(req: RunRequest): AsyncGenerator<AgentEvent, void> {
    let built: BuiltInvocation | undefined;
    let finished = false;
    try {
      assertSafeChoice(req);
      built = await this.build(req);
      const parse = this.createParser();
      const stream = runProcess({
        command: await this.command(),
        args: built.args,
        stdin: built.stdin,
        cwd: req.cwd,
        env: this.env(),
        signal: req.signal,
        timeoutMs: req.timeoutMs,
      });
      for await (const line of stream) {
        this.opts.onRawLine?.(line);
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue; // banners and warnings printed on stdout are not protocol messages
        }
        for (const event of parse(raw)) {
          if (finished) break;
          if (event.type === 'done') finished = true;
          yield event.type === 'error' ? { ...event, message: friendlyError(this.displayName, event.message) } : event;
        }
        if (finished) break;
      }
      if (!finished) {
        finished = true;
        yield { type: 'done', status: 'ok' };
      }
    } catch (err) {
      if (finished) return;
      finished = true;
      if (err instanceof CliAbortError) {
        if (err.reason === 'timeout') {
          yield { type: 'error', code: 'timeout', message: `O ${this.displayName} atingiu o limite de tempo do turno.` };
          yield { type: 'done', status: 'error' };
        } else {
          yield { type: 'done', status: 'cancelled' };
        }
        return;
      }
      const message =
        err instanceof CliExitError
          ? err.stderrTail || `${this.displayName} exited with code ${err.code}`
          : err instanceof Error
            ? err.message
            : String(err);
      yield { type: 'error', message: friendlyError(this.displayName, message) };
      yield { type: 'done', status: 'error' };
    } finally {
      await built?.cleanup?.().catch(() => {});
    }
  }
}
