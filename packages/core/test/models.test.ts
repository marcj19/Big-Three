import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertSafeChoice } from '../src/adapters/base.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { GeminiAdapter, parseAgyModels } from '../src/adapters/gemini.js';
import type { ResolvedCommand } from '../src/command.js';
import type { AgentEvent, RunRequest } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-cli.mjs');
const fake = (...args: string[]): ResolvedCommand => ({ file: process.execPath, prefixArgs: [FAKE, ...args] });

async function collect(adapter: { run(req: RunRequest): AsyncGenerator<AgentEvent, void> }, req: Partial<RunRequest> = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of adapter.run({ prompt: 'ping', cwd: process.cwd(), ...req })) events.push(e);
  return events;
}

/** What `agy models` printed on this machine (trimmed), tab-separated after a progress line. */
const AGY_OUTPUT = [
  'Fetching available models...',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
];

describe('parseAgyModels', () => {
  it('reads id and label, skipping the progress line', () => {
    expect(parseAgyModels(AGY_OUTPUT)).toEqual([
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
      { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
    ]);
  });

  it('ignores blank lines, unusual ids and lines without a label separator', () => {
    expect(parseAgyModels(['', '   ', '-rf\tbad', 'has space\tx', 'no-tab-here', 'ok-1\tFine'])).toEqual([{ id: 'ok-1', label: 'Fine' }]);
  });
});

describe('model and effort choices', () => {
  it('accepts normal names and rejects anything that could be read as an option', () => {
    for (const model of ['opus', 'claude-opus-5-5', 'gemini-3.8-flash-low', 'gpt-5.1-codex', 'vendor/model:v2']) expect(() => assertSafeChoice({ model }), model).not.toThrow();
    for (const model of ['--dangerously-skip-permissions', '-p', 'a b', 'x;rm', '$(id)', 'a'.repeat(101), '../x']) expect(() => assertSafeChoice({ model }), model).toThrow(/Invalid model/);
    for (const effort of ['high', 'xhigh']) expect(() => assertSafeChoice({ effort })).not.toThrow();
    for (const effort of ['--x', 'HIGH', 'a b', '1']) expect(() => assertSafeChoice({ effort }), effort).toThrow(/Invalid effort/);
  });

  it('a bad model never reaches the CLI: the run ends with an error instead', async () => {
    const events = await collect(new ClaudeAdapter({ command: fake('claude-ok') }), { model: '--dangerously-skip-permissions' });
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(events.at(-1)).toMatchObject({ status: 'error' });
  });

  it('passes model and effort to Claude as separate arguments', async () => {
    class Spy extends ClaudeAdapter {
      args: string[] = [];
      protected override async build(req: RunRequest) {
        const b = await super.build(req);
        this.args = b.args;
        return b;
      }
    }
    const spy = new Spy({ command: fake('no-result') });
    await collect(spy, { model: 'claude-opus-5-5', effort: 'high' });
    expect(spy.args.slice(spy.args.indexOf('--model'), spy.args.indexOf('--model') + 2)).toEqual(['--model', 'claude-opus-5-5']);
    expect(spy.args.slice(spy.args.indexOf('--effort'), spy.args.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);

    const plain = new Spy({ command: fake('no-result') });
    await collect(plain, {});
    expect(plain.args).not.toContain('--model');
    expect(plain.args).not.toContain('--effort');
  });

  it('passes model to Antigravity and effort to Codex in their own way', async () => {
    class SpyGemini extends GeminiAdapter {
      args: string[] = [];
      protected override build(req: RunRequest) {
        const b = super.build(req);
        this.args = b.args;
        return b;
      }
    }
    class SpyCodex extends CodexAdapter {
      args: string[] = [];
      protected override build(req: RunRequest) {
        const b = super.build(req);
        this.args = b.args;
        return b;
      }
    }
    const g = new SpyGemini({ command: fake('no-result') });
    await collect(g, { model: 'gemini-4-argon-high' });
    expect(g.args.slice(g.args.indexOf('--model'), g.args.indexOf('--model') + 2)).toEqual(['--model', 'gemini-4-argon-high']);

    const c = new SpyCodex({ command: fake('no-result') });
    await collect(c, { model: 'gpt-5.1-codex', effort: 'medium' });
    expect(c.args).toContain('gpt-5.1-codex');
    expect(c.args).toContain('model_reasoning_effort="medium"');
  });
});

describe('resuming a Codex session', () => {
  class Spy extends CodexAdapter {
    args: string[] = [];
    protected override build(req: RunRequest) {
      const b = super.build(req);
      this.args = b.args;
      return b;
    }
  }

  it('uses a config override for the sandbox, because `exec resume` has no --sandbox flag', async () => {
    const spy = new Spy({ command: fake('no-result') });
    await collect(spy, { sessionId: '0198-uuid', access: 'edit' });
    expect(spy.args.slice(0, 3)).toEqual(['exec', 'resume', '0198-uuid']);
    expect(spy.args).not.toContain('--sandbox');
    expect(spy.args).toContain('sandbox_mode="workspace-write"');
    expect(spy.args.at(-1)).toBe('-');
  });

  it('a first run still uses --sandbox', async () => {
    const spy = new Spy({ command: fake('no-result') });
    await collect(spy, { access: 'read-only' });
    expect(spy.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
    expect(spy.args).not.toContain('resume');
  });
});

describe('MCP servers for Codex', () => {
  class Spy extends CodexAdapter {
    args: string[] = [];
    protected override build(req: RunRequest) {
      const b = super.build(req);
      this.args = b.args;
      return b;
    }
  }

  it('passes the server\'s command, arguments and environment, and a timeout long enough to ask a colleague', async () => {
    const spy = new Spy({ command: fake('no-result') });
    await collect(spy, {
      mcpServers: [{ name: 'room', command: 'C:\\node\\node.exe', args: ['C:\\app\\peer-main.js'], env: { AIO_ROOM_FILE: 'C:\\tmp\\room.jsonl', AIO_ROOM_TEAM: '{"gemini":{"model":"g"}}' } }],
    });
    const configs = spy.args.filter((_, i) => spy.args[i - 1] === '-c');
    expect(configs).toContain('mcp_servers.room.command="C:\\\\node\\\\node.exe"');
    expect(configs).toContain('mcp_servers.room.args=["C:\\\\app\\\\peer-main.js"]');
    expect(configs).toContain('mcp_servers.room.env={AIO_ROOM_FILE = "C:\\\\tmp\\\\room.jsonl", AIO_ROOM_TEAM = "{\\"gemini\\":{\\"model\\":\\"g\\"}}"}');
    expect(configs).toContain('mcp_servers.room.tool_timeout_sec=240');
    expect(configs).toContain('mcp_servers.room.default_tools_approval_mode="approve"');
  });

  it('leaves the env out when there is none, and refuses odd server names', async () => {
    const spy = new Spy({ command: fake('no-result') });
    await collect(spy, { mcpServers: [{ name: 'db', command: 'node' }] });
    expect(spy.args.some((a) => a.includes('.env='))).toBe(false);

    const events = await collect(new Spy({ command: fake('no-result') }), { mcpServers: [{ name: 'a.b=c', command: 'node' }] });
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
  });
});

describe('model lists', () => {
  it('Claude offers the account default first, then aliases and pinned versions', async () => {
    const models = await new ClaudeAdapter({ command: fake('no-result') }).listModels();
    expect(models[0]).toEqual({ id: '', label: 'Padrão da conta' });
    const ids = models.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5']));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids.filter(Boolean)) expect(() => assertSafeChoice({ model: id })).not.toThrow();
  });

  it('Gemini lists what `agy models` reports, behind the account default', async () => {
    const models = await new GeminiAdapter({ command: fake('replay', path.join(here, 'fixtures', 'agy-models.txt')) }).listModels();
    expect(models.map((m) => m.id)).toEqual(['', 'gemini-4-argon-high', 'claude-sonnet-5-5-medium']);
  });

  it('Gemini falls back to the default alone when the CLI fails', async () => {
    expect(await new GeminiAdapter({ command: fake('fail') }).listModels()).toEqual([{ id: '', label: 'Padrão da conta' }]);
  });

  it('only Claude and Codex take a separate effort', () => {
    expect(new ClaudeAdapter().efforts).toContain('high');
    expect(new CodexAdapter().efforts).toContain('high');
    expect(new GeminiAdapter().efforts).toEqual([]);
  });
});
