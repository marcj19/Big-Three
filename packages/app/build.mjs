// tsc compiles the main process and services (ESM) into dist/. This script adds what tsc does not do:
// bundles the window's code with an on-demand 3D chunk, and copies static files and the CommonJS preload.
import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/renderer', { recursive: true });
await mkdir('dist/main', { recursive: true });

await build({
  entryPoints: ['src/renderer/app.ts'],
  outdir: 'dist/renderer',
  bundle: true,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'warning',
});

await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
await copyFile('src/renderer/styles.css', 'dist/renderer/styles.css');
await copyFile('assets/icon.png', 'dist/renderer/icon.png');
await copyFile('src/main/preload.cjs', 'dist/main/preload.cjs');
