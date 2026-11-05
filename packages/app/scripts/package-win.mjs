import { spawnSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('Build the portable version on Windows x64 or Windows ARM64.');
}
if (!process.env.npm_execpath) throw new Error('Run npm run package:win from the project.');

const require = createRequire(import.meta.url);
const repo = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const outputPath = path.join(repo, 'dist');
await mkdir(outputPath, { recursive: true });
const output = await realpath(outputPath);

function assertInside(parent, target) {
  const relative = path.relative(parent, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Unexpected package path: ' + target);
  }
}

assertInside(repo, output);
const workspaces = ['app', 'core', 'db-broker', 'room'];
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const appManifest = await readJson(path.join(repo, 'packages', 'app', 'package.json'));
const version = appManifest.version;
const installer = process.argv.includes('--installer');
if (installer && process.arch !== 'x64') throw new Error('The Windows installer currently targets x64.');
const publish = { provider: 'github', owner: 'marcj19', repo: 'Big-Three', releaseType: 'release' };
const preferred = path.join(output, 'Big Three-' + version + '-win-' + process.arch);
assertInside(output, preferred);
let bundle;
try {
  await mkdir(preferred);
  bundle = preferred;
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  bundle = await mkdtemp(preferred + '-');
}
bundle = await realpath(bundle);
assertInside(output, bundle);
const runtimeApp = path.join(bundle, 'resources', 'app');

try {
  const electron = require('electron');
  await cp(path.dirname(electron), bundle, { recursive: true });
  await rename(path.join(bundle, 'electron.exe'), path.join(bundle, 'Big Three.exe'));
  await rename(path.join(bundle, 'electron_wer.dll'), path.join(bundle, 'Big Three_wer.dll'));
  await mkdir(runtimeApp, { recursive: true });
  await copyFile(path.join(repo, 'LICENSE'), path.join(bundle, 'LICENSE.Big-Three'));

  // Keep the workspace layout and lockfile while installing production dependencies.
  for (const file of ['package.json', 'package-lock.json']) {
    await copyFile(path.join(repo, file), path.join(runtimeApp, file));
  }
  for (const name of workspaces) {
    const workspace = path.join('packages', name);
    const target = path.join(runtimeApp, workspace);
    await mkdir(target, { recursive: true });
    await copyFile(path.join(repo, workspace, 'package.json'), path.join(target, 'package.json'));
  }

  const install = spawnSync(process.execPath, [
    process.env.npm_execpath, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-bin-links', '--prefer-offline',
  ], { cwd: runtimeApp, stdio: 'inherit' });
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error('Could not install the packaged runtime dependencies.');

  const scope = await realpath(path.join(runtimeApp, 'node_modules', '@aio'));
  assertInside(bundle, scope);
  for (const name of workspaces) {
    const workspace = path.join('packages', name);
    const target = await realpath(path.join(runtimeApp, workspace));
    assertInside(bundle, target);
    await cp(path.join(repo, workspace, 'dist'), path.join(target, 'dist'), { recursive: true });

    // npm uses workspace junctions on Windows. The distributed folders must be independent of the build path.
    const link = path.join(scope, name);
    if (!(await lstat(link)).isSymbolicLink()) throw new Error('Expected a workspace link at ' + link);
    await unlink(link);
    if (name !== 'app') await rename(target, link);
  }

  await writeFile(path.join(runtimeApp, 'package.json'), JSON.stringify({
    name: appManifest.name,
    version,
    type: 'module',
    main: 'packages/app/dist/main/main.js',
  }, null, 2) + '\n');
  await unlink(path.join(runtimeApp, 'package-lock.json'));
  if (installer) {
    // With a prepackaged directory Electron Builder does not write the feed into the application.
    await writeFile(path.join(bundle, 'resources', 'app-update.yml'), JSON.stringify({
      ...publish,
      updaterCacheDirName: 'big-three-updater',
    }, null, 2) + '\n');
    const { build, Platform, Arch } = await import('electron-builder');
    const artifacts = await build({
      projectDir: repo,
      prepackaged: bundle,
      targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
      publish: 'never',
      config: {
        appId: 'com.marcj19.bigthree',
        productName: 'Big Three',
        extraMetadata: { version, main: 'packages/app/dist/main/main.js' },
        electronVersion: require('electron/package.json').version,
        directories: { output: path.join(output, 'installer') },
        win: { executableName: 'Big Three', signAndEditExecutable: false },
        nsis: { oneClick: true, perMachine: false, artifactName: 'Big-Three-Setup-${version}-${arch}.${ext}' },
        publish,
      },
    });
    console.log(artifacts.join('\n'));
  } else {
    console.log('Windows executable: ' + path.join(bundle, 'Big Three.exe'));
  }
} catch (error) {
  assertInside(output, await realpath(bundle));
  await rm(bundle, { recursive: true, force: true }).catch((cleanupError) => {
    console.error('Could not remove the incomplete package:', cleanupError.message);
  });
  throw error;
}
