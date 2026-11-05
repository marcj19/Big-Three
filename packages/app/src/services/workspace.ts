import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceDirectory, WorkspaceFile } from '../shared/api.js';

const MAX_BYTES = 256 * 1024;
/** Resolves against a conversation's real root, including symlinks and Windows junctions. */
async function scoped(root: string, relative: string): Promise<string> {
  if (relative.includes('\0') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('O caminho precisa ficar dentro da pasta da conversa.');
  const base = await realpath(root);
  const target = await realpath(path.resolve(base, relative));
  const inside = path.relative(base, target);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('Este link aponta para fora da pasta da conversa.');
  return target;
}
export async function workspaceDirectory(root: string, relative = ''): Promise<WorkspaceDirectory> {
  const target = await scoped(root, relative);
  const entries = (await readdir(target, { withFileTypes: true })).filter((entry) => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink());
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
  return { path: relative.replace(/\\/g, '/'), truncated: entries.length > 500, entries: entries.slice(0, 500).map((entry) => ({
    name: entry.name, path: path.posix.join(relative.replace(/\\/g, '/'), entry.name), kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file',
  })) };
}
export async function workspaceFile(root: string, relative: string): Promise<WorkspaceFile> {
  const target = await scoped(root, relative);
  const file = await open(target, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Escolha um arquivo para visualizar.');
    const buffer = Buffer.alloc(Math.min(info.size, MAX_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead);
    const binary = content.includes(0);
    return { path: relative.replace(/\\/g, '/'), text: binary ? '' : content.toString('utf8').replace(/^\uFEFF/, ''), bytes: info.size, truncated: info.size > bytesRead, binary };
  } finally { await file.close(); }
}
