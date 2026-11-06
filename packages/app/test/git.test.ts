import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeApp, tmp } from './helpers.js';
import { gitDiff, gitStatus } from '../src/services/git.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function init(cwd: string) {
  git(cwd, 'init', '--quiet', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Big Three Test');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'core.autocrlf', 'false');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

describe('conversation Git review', () => {
  it('detects branches and distinguishes the index, working tree and new files', async () => {
    const { app, workdir } = await makeApp();
    const conv = await app.createConversation({ cwd: workdir });
    expect(await app.gitStatus(conv.id)).toEqual({ kind: 'not-repository' });
    await init(workdir);
    expect(await app.gitStatus(conv.id)).toMatchObject({ kind: 'repository', branch: 'main', changes: [] });

    const file = 'versão com espaço.txt';
    await writeFile(path.join(workdir, file), 'base\n');
    git(workdir, 'add', '--', file);
    git(workdir, 'commit', '--quiet', '-m', 'Base');
    git(workdir, 'remote', 'add', 'origin', 'https://test-user:test-secret@example.invalid/team/project.git?token=test-token');
    git(workdir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(workdir, 'branch', '--set-upstream-to=origin/main');
    git(workdir, 'commit', '--quiet', '--allow-empty', '-m', 'Local');
    await writeFile(path.join(workdir, file), 'staged\n');
    git(workdir, 'add', '--', file);
    await writeFile(path.join(workdir, file), 'working tree\n');
    await writeFile(path.join(workdir, 'new.txt'), 'novo\n');

    expect(await app.gitStatus(conv.id)).toMatchObject({
      kind: 'repository', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0,
      origin: 'example.invalid/team/project.git',
      changes: [{ path: file, index: 'M', worktree: 'M' }, { path: 'new.txt', index: '?', worktree: '?' }],
    });
    expect((await app.gitDiff(conv.id, { path: file, source: 'index' })).text).toContain('-base\n+staged');
    expect((await app.gitDiff(conv.id, { path: file, source: 'worktree' })).text).toContain('-staged\n+working tree');
    expect(await app.gitDiff(conv.id, { path: 'new.txt', source: 'untracked' })).toMatchObject({ text: 'novo\n', binary: false });
    git(workdir, 'checkout', '--quiet', '--detach');
    expect(await app.gitStatus(conv.id)).toMatchObject({ branch: null });
  });

  it('recognizes renames and limits review to the selected subfolder', async () => {
    const cwd = await tmp();
    const folder = path.join(cwd, 'subfolder');
    await init(cwd);
    await mkdir(folder);
    await writeFile(path.join(folder, 'old.txt'), 'original\n');
    await writeFile(path.join(cwd, 'outside.txt'), 'outside\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', 'Base');
    git(cwd, 'mv', 'subfolder/old.txt', 'subfolder/novo.txt');
    await writeFile(path.join(cwd, 'outside.txt'), 'private changes\n');
    await writeFile(path.join(folder, '[literal].txt'), 'added\n');
    git(cwd, '--literal-pathspecs', 'add', '--', 'subfolder/[literal].txt');

    const rename = { path: 'subfolder/novo.txt', previousPath: 'subfolder/old.txt', source: 'index' } as const;
    expect(await gitStatus(folder)).toMatchObject({ changes: [
      { path: 'subfolder/[literal].txt', index: 'A' }, { path: rename.path, previousPath: rename.previousPath, index: 'R' },
    ] });
    expect((await gitDiff(folder, rename)).text).toContain('rename from subfolder/old.txt');
    expect((await gitDiff(folder, { path: 'subfolder/[literal].txt', source: 'index' })).text).toContain('+added');
    await expect(gitDiff(folder, { path: 'outside.txt', source: 'worktree' })).rejects.toThrow(/dentro da pasta/);
    await expect(gitDiff(folder, { ...rename, previousPath: 'outside.txt' })).rejects.toThrow(/dentro da pasta/);
  });

  it('inspects files without executing a Git filter configured by the repository', async () => {
    const cwd = await tmp();
    await init(cwd);
    await writeFile(path.join(cwd, 'file.txt'), 'before\n');
    await writeFile(path.join(cwd, '.gitattributes'), '*.txt filter=aio-test\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', 'Base');
    git(cwd, 'config', 'filter.aio-test.clean', 'exit 42');
    git(cwd, 'config', 'filter.aio-test.required', 'true');
    await writeFile(path.join(cwd, 'file.txt'), 'after\n');
    expect(await gitStatus(cwd)).toMatchObject({ changes: [{ path: 'file.txt', worktree: 'M' }] });
    expect((await gitDiff(cwd, { path: 'file.txt', source: 'worktree' })).text).toContain('+after');
  });
});
