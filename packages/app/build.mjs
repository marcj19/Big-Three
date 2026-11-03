// tsc compiles the main process and services (ESM) into dist/. This script adds what tsc does not do:
// bundles the window's code into one script, and copies the static files and the CommonJS preload.
import { copyFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/renderer', { recursive: true });
await mkdir('dist/main', { recursive: true });

await build({
  entryPoints: ['src/renderer/app.ts'],
  outfile: 'dist/renderer/app.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'warning',
});

await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
await copyFile('src/renderer/styles.css', 'dist/renderer/styles.css');
await copyFile('src/main/preload.cjs', 'dist/main/preload.cjs');
