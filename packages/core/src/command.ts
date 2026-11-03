import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** An executable plus any leading arguments it needs (e.g. `node` + a script). Never run through a shell. */
export interface ResolvedCommand {
  file: string;
  prefixArgs: string[];
}

const exists = (p: string) => access(p).then(() => true, () => false);

/** Folders where per-user CLI installs usually land but that may be missing from a GUI app's PATH. */
function defaultSearchDirs(): string[] {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
  return dirs;
}

/**
 * npm installs CLIs on Windows as `.cmd` shims. Node refuses to spawn those without a shell, and a shell would
 * let prompt text be interpreted as commands. Read the shim to find the real JavaScript entry and run it with node.
 */
async function unwrapCmdShim(shim: string, nodePath: string): Promise<ResolvedCommand> {
  const text = await readFile(shim, 'utf8');
  const m = /"%dp0%\\([^"]+?\.(?:c|m)?js)"/i.exec(text);
  if (!m) throw new Error(`Cannot run ${shim} safely: not a recognised npm shim`);
  // The shim writes Windows separators; splitting on them keeps the result right wherever this runs (and in tests).
  return { file: nodePath, prefixArgs: [path.join(path.dirname(shim), ...m[1]!.split('\\'))] };
}

export interface ResolveOptions {
  /** Explicit path to the executable, e.g. from user settings. Wins over PATH search. */
  explicitPath?: string;
  searchDirs?: string[];
  /** Searched after PATH and the usual per-user install folders (for CLIs that install somewhere unusual). */
  extraDirs?: string[];
  /** Node binary used to run unwrapped npm shims. */
  nodePath?: string;
}

/**
 * The binary that runs unwrapped npm shims. Inside Electron `process.execPath` is the app itself, which would open
 * another window instead of running the script, so look for a real node on PATH there.
 */
async function nodeBinary(): Promise<string> {
  if (!process.versions.electron) return process.execPath;
  const win = process.platform === 'win32';
  for (const dir of defaultSearchDirs()) {
    const candidate = path.join(dir, win ? 'node.exe' : 'node');
    if (await exists(candidate)) return candidate;
  }
  throw new Error('Node.js was not found on PATH; it is needed to run the npm-installed model CLIs');
}

export async function resolveCommand(name: string, opts: ResolveOptions = {}): Promise<ResolvedCommand> {
  const win = process.platform === 'win32';
  const node = async () => opts.nodePath ?? (await nodeBinary());
  const candidates: string[] = [];

  if (opts.explicitPath) {
    candidates.push(opts.explicitPath);
  } else {
    const exts = win ? ['.exe', '.cmd', ''] : [''];
    for (const dir of [...(opts.searchDirs ?? defaultSearchDirs()), ...(opts.extraDirs ?? [])]) {
      for (const ext of exts) candidates.push(path.join(dir, name + ext));
    }
  }

  for (const file of candidates) {
    if (!(await exists(file))) continue;
    if (/\.(cmd|bat)$/i.test(file)) return unwrapCmdShim(file, await node());
    if (/\.(c|m)?js$/i.test(file)) return { file: await node(), prefixArgs: [file] };
    return { file, prefixArgs: [] };
  }
  throw new Error(`Could not find "${name}"${opts.explicitPath ? ` at ${opts.explicitPath}` : ' on PATH or in the usual install folders'}`);
}
