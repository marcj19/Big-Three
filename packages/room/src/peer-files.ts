import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Files the lead sends along with a question, so the colleague does not spend a whole model turn (and the CLI's
 * ~20k-token base context again) just to open them. A colleague can already read the project, so this adds no access:
 * it stays inside the project folder and refuses the kinds of files that usually hold secrets.
 */
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 40_000;
export const MAX_TOTAL_BYTES = 80_000;

const SECRET_NAME = /(^|[\\/])(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)|credentials(\..*)?|secrets?(\..*)?|[^\\/]*\.(pem|key|p12|pfx|kdbx))$/i;
const inside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export interface InlinedFiles {
  /** Ready to append to the colleague's instruction; empty when nothing could be included. */
  text: string;
  included: string[];
  /** What was left out and why, for the lead to read. */
  skipped: string[];
}

export async function inlineFiles(cwd: string, requested: string[] | undefined): Promise<InlinedFiles> {
  const result: InlinedFiles = { text: '', included: [], skipped: [] };
  if (!requested?.length) return result;
  let root: string;
  try { root = await realpath(cwd); } catch { return { ...result, skipped: requested.map((f) => `${f}: project folder not found`) }; }
  const blocks: string[] = [];
  let total = 0;
  for (const name of [...new Set(requested)].slice(0, MAX_FILES)) {
    if (SECRET_NAME.test(name)) { result.skipped.push(`${name}: looks like a secrets file`); continue; }
    try {
      const real = await realpath(path.resolve(root, name));
      if (!inside(root, real)) { result.skipped.push(`${name}: outside the project folder`); continue; }
      if (SECRET_NAME.test(real) || /(^|[\\/])\.git[\\/]/.test(path.relative(root, real))) { result.skipped.push(`${name}: not shared`); continue; }
      if (!(await stat(real)).isFile()) { result.skipped.push(`${name}: not a file`); continue; }
      const buffer = await readFile(real);
      if (buffer.includes(0)) { result.skipped.push(`${name}: binary file`); continue; }
      let text = buffer.toString('utf8');
      let note = '';
      if (buffer.length > MAX_FILE_BYTES) { text = text.slice(0, MAX_FILE_BYTES); note = `\n[... cut at ${MAX_FILE_BYTES} bytes; the colleague can open the rest]`; }
      if (total + text.length > MAX_TOTAL_BYTES) { result.skipped.push(`${name}: size limit for this question reached`); continue; }
      total += text.length;
      const numbered = text.split('\n').map((line, i) => `${String(i + 1).padStart(4)}| ${line}`).join('\n');
      blocks.push(`--- ${path.relative(root, real).split(path.sep).join('/')} ---\n${numbered}${note}`);
      result.included.push(name);
    } catch {
      result.skipped.push(`${name}: not found`);
    }
  }
  if (requested.length > MAX_FILES) result.skipped.push(`${requested.length - MAX_FILES} more file(s): at most ${MAX_FILES} per question`);
  if (blocks.length) {
    result.text = `\n\nFILES, complete read-only copies with line numbers (no need to open them again):\n${blocks.join('\n\n')}`;
  }
  return result;
}
