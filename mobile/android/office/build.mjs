import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const output = process.argv[2];
if (!output) throw new Error('An Android asset output directory is required.');
const file = (name) => fileURLToPath(new URL(name, import.meta.url));
const { outputFiles } = await build({ entryPoints: [file('office.ts')], bundle: true, write: false,
  minify: true, format: 'iife', platform: 'browser', target: 'chrome100' });
const script = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const hash = createHash('sha256').update(script).digest('base64');
const template = await readFile(file('office.html'), 'utf8');
const html = template.replace('<!--office-hash-->', hash).replace('<!--office-script-->', () => script);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'office.html'), html);
