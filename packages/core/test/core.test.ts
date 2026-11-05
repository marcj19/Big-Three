import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import { resolveCommand, type ResolvedCommand } from '../src/command.js';
import { sanitizeEnv } from '../src/env.js';
import { CliAbortError, CliExitError, runProcess } from '../src/runner.js';
import type { AgentEvent, Adapter, RunRequest } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-cli.mjs');
const fixture = (n: string) => path.join(here, 'fixtures', n);
const fake = (...args: string[]): ResolvedCommand => ({ file: process.execPath, prefixArgs: [FAKE, ...args] });

async function collect(adapter: Adapter, req: Partial<RunRequest> = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of adapter.run({ prompt: 'ping', cwd: process.cwd(), ...req })) events.push(e);
  return events;
}
const types = (events: AgentEvent[]) => events.map((e) => e.type);

describe('sanitizeEnv', () => {
  const base = {
    PATH: '/bin',
    HOME: '/home/u',
    AIO_SECRET_CRM: 'pw',
    DATABASE_URL: 'postgres://u:p@h/db',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-oai',
    GITHUB_TOKEN: 'ghp',
    DB_PASSWORD: 'x',
    MYSQL_PWD_FILE: '/x',
    PGPASSWORD: 'x',
    TOKENIZERS_PARALLELISM: 'false',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  };

  it('removes anything that looks like a credential and keeps ordinary variables', () => {
    const env = sanitizeEnv(base);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'TOKENIZERS_PARALLELISM']);
  });

  it('does not leak a parent Claude Code session into a child CLI', () => {
    const env = sanitizeEnv({
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'x',
      CLAUDE_AGENT_SDK_VERSION: '1',
      ANTHROPIC_BASE_URL: 'http://localhost:1',
    });
    expect(Object.keys(env)).toEqual(['PATH']);
  });

  it('allows an explicit passthrough, case-insensitively, and adds extras', () => {
    const env = sanitizeEnv(base, { passthrough: ['claude_code_oauth_token'], extra: { FOO: 'bar' } });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
    expect(env.FOO).toBe('bar');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('resolveCommand', () => {
  const tmp: string[] = [];
  afterAll(() => Promise.all(tmp.map((d) => rm(d, { recursive: true, force: true }))));
  const mkdir_ = async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'aio-cmd-'));
    tmp.push(d);
    return d;
  };

  it('unwraps an npm .cmd shim into node + script, so no shell is needed', async function () {
    const dir = await mkdir_();
    await mkdir(path.join(dir, 'node_modules', 'pkg', 'bundle'), { recursive: true });
    await writeFile(path.join(dir, 'node_modules', 'pkg', 'bundle', 'tool.js'), '');
    await writeFile(path.join(dir, 'tool.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\pkg\\bundle\\tool.js" %*\r\n');
    const cmd = await resolveCommand('tool', { searchDirs: [dir], explicitPath: path.join(dir, 'tool.cmd'), nodePath: 'NODE' });
    expect(cmd).toEqual({ file: 'NODE', prefixArgs: [path.join(dir, 'node_modules', 'pkg', 'bundle', 'tool.js')] });
  });

  it('refuses a .cmd file that is not a recognised shim', async () => {
    const dir = await mkdir_();
    await writeFile(path.join(dir, 'evil.cmd'), '@echo off\r\ncalc.exe\r\n');
    await expect(resolveCommand('evil', { explicitPath: path.join(dir, 'evil.cmd') })).rejects.toThrow(/not a recognised npm shim/);
  });

  it('reports a missing executable clearly', async () => {
    await expect(resolveCommand('definitely-not-installed-xyz', { searchDirs: [] })).rejects.toThrow(/Could not find/);
  });

  it.skipIf(process.platform !== 'win32')('finds agy in the default Windows installation folder without PATH', async () => {
    const local = await mkdir_();
    const bin = path.join(local, 'agy', 'bin');
    await mkdir(bin, { recursive: true });
    const executable = path.join(bin, 'agy.exe');
    await writeFile(executable, '');
    class GeminiProbe extends GeminiAdapter {
      resolve() { return this.command(); }
    }
    vi.stubEnv('PATH', '');
    vi.stubEnv('LOCALAPPDATA', local);
    try {
      expect((await new GeminiProbe().resolve()).file).toBe(executable);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('runProcess', () => {
  const env = { ...process.env };
  const base = { cwd: process.cwd(), env, stdin: '' };

  it('delivers the prompt on stdin (never argv) and a sanitized env', async () => {
    const secretEnv = sanitizeEnv({ ...process.env, AIO_SECRET_X: 'leak-me', MY_API_KEY: 'leak-me-too' });
    const lines: string[] = [];
    for await (const l of runProcess({ ...base, env: secretEnv, command: fake('echo'), args: ['--flag'], stdin: 'line one\nline two' })) lines.push(l);
    const echo = JSON.parse(lines[0]!);
    expect(echo.stdin).toBe('line one\nline two');
    expect(echo.flags).toEqual(['--flag']);
    expect(echo.envKeys).not.toContain('AIO_SECRET_X');
    expect(echo.envKeys).not.toContain('MY_API_KEY');
  });

  it('does not interpret shell metacharacters in the prompt', async () => {
    const evil = '"; calc.exe & echo pwned #';
    const lines: string[] = [];
    for await (const l of runProcess({ ...base, command: fake('echo'), args: [], stdin: evil })) lines.push(l);
    expect(JSON.parse(lines[0]!).stdin).toBe(evil);
  });

  it('throws CliExitError with stderr on a non-zero exit', async () => {
    const run = async () => {
      for await (const _ of runProcess({ ...base, command: fake('fail'), args: [] })) void _;
    };
    await expect(run()).rejects.toMatchObject({ name: 'CliExitError', code: 3, stderrTail: expect.stringContaining('auth expired') });
    await expect(run()).rejects.toBeInstanceOf(CliExitError);
  });

  it('kills a hung process on abort', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const run = async () => {
      for await (const _ of runProcess({ ...base, command: fake('hang'), args: [], signal: ac.signal })) {
        ac.abort();
      }
    };
    await expect(run()).rejects.toBeInstanceOf(CliAbortError);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('kills a hung process on timeout', async () => {
    const run = async () => {
      for await (const _ of runProcess({ ...base, command: fake('hang'), args: [], timeoutMs: 800 })) void _;
    };
    await expect(run()).rejects.toMatchObject({ name: 'CliAbortError', reason: 'timeout' });
  }, 15_000);

  it('reports a missing binary instead of hanging', async () => {
    const run = async () => {
      for await (const _ of runProcess({ ...base, command: { file: 'no-such-binary-xyz', prefixArgs: [] }, args: [] })) void _;
    };
    await expect(run()).rejects.toThrow(/ENOENT/);
  });
});

describe('ClaudeAdapter', () => {
  it('parses a full stream: session, text, tool call/result, usage, done', async () => {
    const events = await collect(new ClaudeAdapter({ command: fake('replay', fixture('claude.jsonl')) }));
    expect(events).toEqual([
      { type: 'session', sessionId: 'c0ffee00-1111-2222-3333-444455556666' },
      { type: 'text', text: 'Let me look at the schema.' },
      { type: 'tool_call', name: 'mcp__db__list_schema', input: { connection: 'crm' } },
      { type: 'tool_result', isError: false },
      { type: 'text', text: 'There are 3 tables.' },
      { type: 'usage', inputTokens: 120, outputTokens: 45, costUsd: 0.0123 },
      { type: 'done', status: 'ok', text: 'There are 3 tables.' },
    ]);
  });

  it('reports the subscription limit window the CLI announces', async () => {
    const events = await collect(new ClaudeAdapter({ command: fake('replay', fixture('claude-limit.jsonl')) }));
    expect(events.find((e) => e.type === 'limit')).toEqual({ type: 'limit', status: 'allowed', window: 'five_hour', resetsAt: 1793733600_000 });
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'ok', text: 'pong' });
  });

  it('surfaces an error result as error + done(error)', async () => {
    const events = await collect(new ClaudeAdapter({ command: fake('replay', fixture('claude-error.jsonl')) }));
    expect(events.slice(-2)).toEqual([
      { type: 'error', message: 'Credit balance is too low' },
      { type: 'done', status: 'error', text: 'Credit balance is too low' },
    ]);
  });

  it('defaults to read-only and maps access levels to permission modes', async () => {
    const seen: string[][] = [];
    class Spy extends ClaudeAdapter {
      protected override async build(req: RunRequest) {
        const b = await super.build(req);
        seen.push(b.args);
        return b;
      }
    }
    await collect(new Spy({ command: fake('no-result') }));
    for (const access of ['read-only', 'edit', 'full'] as const) await collect(new Spy({ command: fake('no-result') }), { access });
    const modes = seen.map((a) => a[a.indexOf('--permission-mode') + 1]);
    expect(modes).toEqual(['plan', 'plan', 'acceptEdits', 'bypassPermissions']);
  });

  it('puts the prompt on stdin and not in the arguments', async () => {
    let built: { args: string[]; stdin: string } | undefined;
    class Spy extends ClaudeAdapter {
      protected override async build(req: RunRequest) {
        built = await super.build(req);
        return built;
      }
    }
    await collect(new Spy({ command: fake('no-result') }), { prompt: 'secret question', model: 'opus' });
    expect(built?.stdin).toBe('secret question');
    expect(built?.args.join(' ')).not.toContain('secret question');
    expect(built?.args).toContain('--model');
  });

  it('writes an MCP config limited to the given servers, pre-approves only them, and deletes it afterwards', async () => {
    let captured: string[] = [];
    class Spy extends ClaudeAdapter {
      protected override async build(req: RunRequest) {
        const b = await super.build(req);
        captured = b.args;
        return b;
      }
    }
    await collect(new Spy({ command: fake('no-result') }), {
      sessionId: 'sess-77',
      mcpServers: [{ name: 'db', command: 'node', args: ['broker.js'], env: { AIO_CONFIG_DIR: 'C:\\cfg' } }],
    });
    expect(captured).toContain('--strict-mcp-config');
    expect(captured[captured.indexOf('--resume') + 1]).toBe('sess-77');
    expect(captured[captured.indexOf('--allowedTools') + 1]).toBe('mcp__db');
    const cfg = captured[captured.indexOf('--mcp-config') + 1]!;
    await expect(import('node:fs/promises').then((fs) => fs.access(cfg))).rejects.toThrow(); // cleaned up
  });
});

describe('GeminiAdapter (Antigravity CLI)', () => {
  it('parses a real recorded run: conversation id, streamed text, usage, final answer', async () => {
    const events = await collect(new GeminiAdapter({ command: fake('replay', fixture('antigravity.jsonl')) }));
    expect(events).toEqual([
      { type: 'session', sessionId: '0a3cc056-8909-4b6f-bf76-8afdaa1f4dd8' },
      { type: 'text', text: 'pong', partial: true },
      { type: 'text', text: '\n', partial: true },
      { type: 'usage', inputTokens: 9663, outputTokens: 1 },
      { type: 'done', status: 'ok', text: 'pong' },
    ]);
  });

  it('maps tool steps to a named tool call with its parameters, then a result (shape recorded live)', async () => {
    const events = await collect(new GeminiAdapter({ command: fake('replay', fixture('antigravity-tool.jsonl')) }));
    expect(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result')).toEqual([
      {
        type: 'tool_call',
        name: 'write_file',
        input: { Path: 'C:\\Users\\u\\.gemini\\antigravity-cli\\brain\\x\\implementation_plan.md' },
      },
      { type: 'tool_result', name: 'write_file', isError: false },
    ]);
  });

  it('reports a non-SUCCESS result as an error', async () => {
    const events = await collect(new GeminiAdapter({ command: fake('replay', fixture('antigravity-failed.jsonl')) }));
    expect(events.slice(-2)).toEqual([
      { type: 'error', message: 'Antigravity finished with status FAILED' },
      { type: 'done', status: 'error' },
    ]);
  });

  it('attaches the prompt to -p= (the only form agy accepts), keeps stdin empty and defaults to plan mode', async () => {
    let built: { args: string[]; stdin: string } | undefined;
    class Spy extends GeminiAdapter {
      protected override build(req: RunRequest) {
        built = super.build(req);
        return built;
      }
    }
    await collect(new Spy({ command: fake('no-result') }), { prompt: 'what is 2+2?', model: 'gemini-3.8-flash-low', sessionId: 'conv-1' });
    expect(built?.args[0]).toBe('-p=what is 2+2?');
    expect(built?.args[built.args.indexOf('--mode') + 1]).toBe('plan');
    expect(built?.args[built.args.indexOf('--conversation') + 1]).toBe('conv-1');
    expect(built?.stdin).toBe('');
  });

  it('refuses prompts that would overflow the Windows command line, and MCP injection it cannot honour', async () => {
    const tooLong = await collect(new GeminiAdapter({ command: fake('no-result') }), { prompt: 'x'.repeat(30_000) });
    expect(tooLong[0]).toMatchObject({ type: 'error', message: expect.stringContaining('limit') });
    const mcp = await collect(new GeminiAdapter({ command: fake('no-result') }), { prompt: 'x', mcpServers: [{ name: 'db', command: 'node' }] });
    expect(mcp[0]).toMatchObject({ type: 'error', message: expect.stringContaining('MCP') });
    expect(mcp.at(-1)).toEqual({ type: 'done', status: 'error' });
  });

  it('supports resuming a conversation by id', () => {
    expect(new GeminiAdapter().supportsResume).toBe(true);
  });
});

describe('CodexAdapter', () => {
  it('parses a thread with a shell command and a final message', async () => {
    const events = await collect(new CodexAdapter({ command: fake('replay', fixture('codex.jsonl')) }));
    expect(events).toEqual([
      { type: 'session', sessionId: 'thr-9' },
      { type: 'tool_call', name: 'shell', input: 'ls' },
      { type: 'tool_result', name: 'shell', isError: false },
      { type: 'text', text: 'Listed the files.' },
      { type: 'usage', inputTokens: 200, outputTokens: 30 },
      { type: 'done', status: 'ok', text: 'Listed the files.' },
    ]);
  });

  it('reports an expired timer as a failure and a stop signal as cancellation', async () => {
    const command = fake('hang');
    const events = await collect(new CodexAdapter({ command }), { timeoutMs: 800 });
    expect(events).toEqual([
      { type: 'error', code: 'timeout', message: 'O Codex atingiu o limite de tempo do turno.' },
      { type: 'done', status: 'error' },
    ]);

    const abort = new AbortController();
    const adapter = new CodexAdapter({ command, onRawLine: () => abort.abort() });
    expect(await collect(adapter, { timeoutMs: 0, signal: abort.signal })).toEqual([
      { type: 'done', status: 'cancelled' },
    ]);
  }, 15_000);
});

describe('sign-in from the app', () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
  const stateFile = async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'aio-auth-'));
    dirs.push(d);
    return path.join(d, 'signed-in');
  };
  const drain = async (gen: AsyncGenerator<unknown>) => {
    const out: unknown[] = [];
    for await (const e of gen) out.push(e);
    return out;
  };

  it('reports signed out, runs the CLI sign-in with the subscription flag, then reports signed in', async () => {
    const file = await stateFile();
    const adapter = new ClaudeAdapter({ command: fake('authcli', file) });
    expect(adapter.canLogin).toBe(true);
    expect(await adapter.authStatus()).toEqual({ signedIn: false, detail: 'none' });

    const events = await drain(adapter.login());
    expect(events).toEqual([
      { type: 'output', line: 'Opening browser to sign in...' },
      { type: 'output', line: 'If it did not open, visit https://example.invalid/login' },
      { type: 'done', ok: true },
    ]);
    expect(await adapter.authStatus()).toEqual({ signedIn: true, detail: 'claude.ai' });
  });

  it('reports failure when the browser step was never completed', async () => {
    const file = await stateFile();
    const events = await drain(new ClaudeAdapter({ command: fake('authcli-stuck', file) }).login());
    expect(events.at(-1)).toEqual({ type: 'done', ok: false, message: 'Sign-in did not complete.' });
  });

  it('can be cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const events = await drain(new ClaudeAdapter({ command: fake('hang') }).login(ac.signal));
    expect(events.at(-1)).toEqual({ type: 'done', ok: false, message: 'Sign-in cancelled.' });
  }, 15_000);

  it('tells the user what to do when a CLI has no sign-in command (Gemini)', async () => {
    const gemini = new GeminiAdapter({ command: fake('echo') });
    expect(gemini.canLogin).toBe(false);
    const [done] = (await drain(gemini.login())) as { ok: boolean; message: string }[];
    expect(done?.ok).toBe(false);
    expect(done?.message).toMatch(/run `agy`/);
  });

  it('says "not installed" instead of probing when the CLI is missing', async () => {
    const codex = new CodexAdapter({ executablePath: path.join(os.tmpdir(), 'no-codex-here.exe') });
    expect(await codex.authStatus()).toEqual({ signedIn: false, detail: 'CLI not installed' });
  });
});

describe('adapter run() contract', () => {
  it('ignores non-JSON noise on stdout', async () => {
    const events = await collect(new ClaudeAdapter({ command: fake('banner-noise') }));
    expect(types(events)).toEqual(['session', 'usage', 'done']);
  });

  it('turns a CLI failure into error + done(error) carrying stderr, without throwing', async () => {
    const events = await collect(new ClaudeAdapter({ command: fake('fail') }));
    expect(events).toEqual([
      { type: 'error', message: 'auth expired: please log in again' },
      { type: 'done', status: 'error' },
    ]);
  });

  it('replaces signed-out noise from the CLI with an actionable message', async () => {
    const events = await collect(new ClaudeAdapter({ command: fake('replay', fixture('claude-signed-out.jsonl')) }));
    expect(events.find((e) => e.type === 'error')).toEqual({
      type: 'error',
      message: 'Claude is not signed in. Open a terminal, run the Claude CLI once and sign in with your account, then try again.',
    });
  });

  it('always ends with done(ok) even if the CLI never printed a result', async () => {
    const events = await collect(new ClaudeAdapter({ command: fake('no-result') }));
    expect(events.at(-1)).toEqual({ type: 'done', status: 'ok' });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('ends with done(cancelled) when aborted', async () => {
    const ac = new AbortController();
    const events: AgentEvent[] = [];
    for await (const e of new ClaudeAdapter({ command: fake('hang') }).run({ prompt: 'x', cwd: process.cwd(), signal: ac.signal })) {
      events.push(e);
      if (e.type === 'session') ac.abort();
    }
    expect(events.at(-1)).toEqual({ type: 'done', status: 'cancelled' });
  }, 15_000);

  it('detect() reports version when the CLI runs and a hint when it is missing', async () => {
    expect(await new ClaudeAdapter({ command: fake('echo') }).detect()).toEqual({ available: true, version: '9.9.9-fake' });
    const missing = await new CodexAdapter({ executablePath: path.join(os.tmpdir(), 'no-codex-here.exe') }).detect();
    expect(missing.available).toBe(false);
    expect(missing.reason).toMatch(/npm i -g @openai\/codex/);
  });
});
