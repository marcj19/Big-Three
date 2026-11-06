import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveCommand, type ResolvedCommand } from '@aio/core';
import type { GitChange, GitDiff, GitSelection, GitStatus } from '../shared/api.js';
import { workspaceFile } from './workspace.js';

const CHANGE_LIMIT = 250;
const DIFF_LIMIT = 96 * 1024;

async function gitCommand(): Promise<ResolvedCommand | undefined> {
  // Resolve on PATH before spawning, so Windows never searches the project for git.exe.
  const searchDirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  const extraDirs = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter((dir): dir is string => !!dir).map((dir) => path.join(dir, 'Git', 'cmd'));
  return resolveCommand('git', { searchDirs, extraDirs }).catch(() => undefined);
}

function runGit(command: ResolvedCommand, cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return new Promise<{ text: string; truncated: boolean; code: number }>((resolve, reject) => {
    execFile(command.file, [...command.prefixArgs, '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
      cwd, env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
      windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer,
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ text: stdout, truncated: false, code: 0 });
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ text: stdout, truncated: true, code: 0 });
      if (err.code === 1 || (err.code === 2 && args[0] === 'remote' && stderr.includes('No such remote')) ||
        (err.code === 128 && stderr.includes('not a git repository'))) {
        return resolve({ text: stdout, truncated: false, code: err.code });
      }
      reject(new Error('Não foi possível consultar o Git nesta pasta. Verifique o repositório e as permissões locais.'));
    });
  });
}

async function repositoryRoot(command: ResolvedCommand, cwd: string): Promise<string | undefined> {
  const result = await runGit(command, cwd, ['rev-parse', '--show-toplevel']);
  return result.code === 0 ? realpath(result.text.replace(/\r?\n$/, '')) : undefined;
}

async function filterOverrides(command: ResolvedCommand, cwd: string): Promise<string[]> {
  // Status and diff may run clean filters. Do not execute drivers declared by the project being inspected.
  const result = await runGit(command, cwd, ['config', '--null', '--show-scope', '--name-only', '--get-regexp', '^filter[.].*[.](clean|process|required)$']);
  if (result.truncated || result.code > 1) throw new Error('Não foi possível verificar a configuração do Git.');
  const fields = result.text.split('\0');
  const drivers = new Set<string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i];
    if (scope === 'local' || scope === 'worktree') drivers.add(fields[i + 1]!.replace(/[.][^.]+$/, ''));
  }
  return [...drivers].flatMap((driver) => ['-c', `${driver}.clean=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`]);
}

function originLabel(raw: string): string | undefined {
  const remote = raw.trim();
  if (!remote) return undefined;
  try {
    const url = new URL(remote);
    if (['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) && url.host) return `${url.host}${url.pathname}`;
  } catch { /* SSH also supports user@host:path syntax. */ }
  const ssh = /^(?:[^@\s/:]+@)?([\w.-]+):([^\\?#][^\r\n?#]*)$/.exec(remote);
  return ssh && !/^[a-z]:/i.test(remote) ? `${ssh[1]}/${ssh[2]!.replace(/^\/+/, '')}` : 'Remoto configurado';
}

function parseStatus(raw: string, truncated: boolean, origin?: string): GitStatus {
  const entries = raw.split('\0');
  entries.pop(); // The last field is empty or was cut off by the output limit.
  const header = (entries.shift() ?? '').slice(3).replace(/^No commits yet on /, '');
  const [local = '', tracking] = header.split('...');
  const changes: GitChange[] = [];
  let i = 0;
  while (i < entries.length && changes.length < CHANGE_LIMIT) {
    const entry = entries[i++]!;
    const index = entry[0]!, worktree = entry[1]!;
    const renamed = /[RC]/.test(index + worktree);
    const previousPath = renamed ? entries[i++] : undefined;
    if (renamed && previousPath === undefined) break;
    changes.push({ index, worktree, path: entry.slice(3), previousPath });
  }
  return { kind: 'repository', branch: local === 'HEAD (no branch)' ? null : local, upstream: tracking?.split(' ')[0], origin,
    ahead: Number(tracking?.match(/\bahead (\d+)/)?.[1] ?? 0), behind: Number(tracking?.match(/\bbehind (\d+)/)?.[1] ?? 0),
    changes, truncated: truncated || i < entries.length };
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const command = await gitCommand();
  if (!command) return { kind: 'unavailable' };
  if (!await repositoryRoot(command, cwd)) return { kind: 'not-repository' };
  const overrides = await filterOverrides(command, cwd);
  const [status, remote] = await Promise.all([
    runGit(command, cwd, [...overrides, 'status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--', '.']),
    runGit(command, cwd, ['remote', 'get-url', 'origin']),
  ]);
  if (status.code !== 0) throw new Error('Não foi possível listar as alterações do Git.');
  return parseStatus(status.text, status.truncated, remote.code === 0 && !remote.truncated ? originLabel(remote.text) : undefined);
}

function relativeInScope(cwd: string, target: string): string {
  const relative = path.relative(cwd, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('O arquivo precisa ficar dentro da pasta da conversa.');
  }
  return relative;
}

export async function gitDiff(cwd: string, selection: GitSelection): Promise<GitDiff> {
  const command = await gitCommand();
  const root = command && await repositoryRoot(command, cwd);
  if (!command || !root) throw new Error('Abra uma pasta de repositório Git para ver as alterações.');
  const scope = await realpath(cwd);
  const paths = [selection.path, selection.previousPath].filter((name): name is string => name !== undefined);
  const relativePaths = paths.map((name) => {
    if (name.includes('\0') || path.isAbsolute(name) || name.split('/').includes('..') || (process.platform === 'win32' && /[:\\]/.test(name))) {
      throw new Error('O arquivo precisa ficar dentro da pasta da conversa.');
    }
    return relativeInScope(scope, path.resolve(root, name));
  });
  if (selection.source === 'untracked') {
    const file = await workspaceFile(scope, relativePaths[0]!);
    return { text: file.text.slice(0, DIFF_LIMIT), truncated: file.truncated || file.text.length > DIFF_LIMIT, binary: file.binary };
  }
  if (selection.source === 'worktree') {
    for (const relative of relativePaths) {
      const target = await realpath(path.join(scope, relative)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
        return undefined; // Deleted files still have a diff.
      });
      if (target) relativeInScope(scope, target);
    }
  }
  const overrides = await filterOverrides(command, root);
  const diff = await runGit(command, root, [...overrides, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
    '--ignore-submodules=dirty', '--submodule=short', '--find-renames', ...(selection.source === 'index' ? ['--cached'] : []), '--', ...paths], 512 * 1024);
  if (diff.code !== 0) throw new Error('Não foi possível ler a diferença deste arquivo.');
  return { text: diff.text.slice(0, DIFF_LIMIT), truncated: diff.truncated || diff.text.length > DIFF_LIMIT };
}
