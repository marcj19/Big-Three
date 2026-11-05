import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeApp, tmp } from './helpers.js';
import { workspaceDirectory, workspaceFile } from '../src/services/workspace.js';

describe('scoped project explorer', () => {
  it('lists directories first and previews actual text without modifying it', async () => {
    const root = await tmp();
    await mkdir(path.join(root, 'src')); await writeFile(path.join(root, 'readme.md'), '# Projeto\nTexto');
    const dir = await workspaceDirectory(root);
    expect(dir.entries.map((entry) => entry.name)).toEqual(['src', 'readme.md']);
    expect(await workspaceFile(root, 'readme.md')).toMatchObject({ text: '# Projeto\nTexto', binary: false, truncated: false });
  });
  it('rejects absolute paths, traversal and junctions that leave the chosen folder', async () => {
    const root = await tmp(), outside = await tmp();
    await writeFile(path.join(outside, 'private.txt'), 'outside');
    await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const relative of ['../private.txt', '..\\private.txt', '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share\\file', 'escape/private.txt']) {
      await expect(workspaceFile(root, relative)).rejects.toThrow();
    }
    await expect(workspaceDirectory(root, 'escape')).rejects.toThrow(/fora/);
  });
  it('bounds large files and identifies binary content', async () => {
    const root = await tmp();
    await writeFile(path.join(root, 'large.txt'), 'a'.repeat(300000));
    await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 2, 3]));
    const large = await workspaceFile(root, 'large.txt');
    expect(large.truncated).toBe(true); expect(large.text.length).toBe(256 * 1024);
    expect(await workspaceFile(root, 'binary.dat')).toMatchObject({ binary: true, text: '' });
  });
  it('gets the root from the selected conversation, not from a caller-supplied absolute folder', async () => {
    const { app, workdir } = await makeApp();
    await writeFile(path.join(workdir, 'inside.txt'), 'safe');
    const conv = await app.createConversation({ cwd: workdir });
    expect(await app.workspaceFile(conv.id, 'inside.txt')).toMatchObject({ text: 'safe' });
    await expect(app.workspaceFile('../../x', 'inside.txt')).rejects.toThrow();
    await expect(app.workspaceFile(conv.id, path.join(workdir, 'inside.txt'))).rejects.toThrow();
  });
});
