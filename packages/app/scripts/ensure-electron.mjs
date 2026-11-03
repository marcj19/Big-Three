// Some npm setups skip install scripts, which leaves Electron without its runtime and `electron .` failing with a
// confusing message. This fetches the runtime once if it is missing (about 110 MB, from Electron's own releases).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronDir = path.dirname(require.resolve('electron/package.json'));

if (!existsSync(path.join(electronDir, 'path.txt'))) {
  console.log('Downloading the Electron runtime (first run only)...');
  const result = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Could not download Electron. Check your internet connection and run `npm start` again.');
    process.exit(result.status ?? 1);
  }
}
