import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configDir } from '@aio/db-broker';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { AppService } from '../services/app-service.js';
import { API_METHODS, type AppEvent } from '../shared/api.js';
import { EmbeddedBrowser } from './browser.js';
import { demoAdapters } from '../dev/demo-adapters.js';
import electronUpdater from 'electron-updater';
import { AppUpdates } from './updates.js';
import { MobileGateway } from '../services/mobile.js';
import { ANDROID_DOWNLOAD } from '../shared/mobile.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(path.join(here, '..', 'renderer', 'index.html')).href;
if (process.env.AIO_DEMO === '1') {
  const demoData = path.join(configDir(), 'electron-demo');
  mkdirSync(demoData, { recursive: true });
  app.setPath('userData', demoData);
}

let win: BrowserWindow | null = null;
const browser = new EmbeddedBrowser((state) => win?.webContents.send('aio:event', { type: 'browser', state } satisfies AppEvent));
const installed = process.platform === 'win32' && app.isPackaged && process.env.AIO_DEMO !== '1'
  && existsSync(path.join(process.resourcesPath, 'app-update.yml'));
const updates = new AppUpdates(app.getVersion(), installed ? electronUpdater.autoUpdater : undefined,
  (state) => win?.webContents.send('aio:event', { type: 'update', state } satisfies AppEvent));

const confirmAccess = async ({ access, cwd, summary }: { access: 'edit' | 'full'; cwd: string; summary: string }) => {
  const full = access === 'full';
  const { response } = await dialog.showMessageBox(win ?? undefined!, {
    type: 'warning',
    buttons: ['Cancelar', full ? 'Permitir acesso total' : 'Permitir edição'],
    defaultId: 0,
    cancelId: 0,
    title: 'Permitir que o modelo altere arquivos?',
    message: full ? 'Acesso TOTAL: o modelo pode rodar comandos e alterar arquivos sem pedir.' : 'O modelo poderá criar e editar arquivos.',
    detail: `${summary}\n\nPasta: ${cwd}\n\nEsta escolha fica salva nesta conversa. Você pode reduzi-la no seletor de acesso do chat.`,
  });
  return response === 1;
};

const service = new AppService({
  configDir: configDir(),
  browser,
  updates,
  adapters: process.env.AIO_DEMO === '1' ? demoAdapters() : undefined,
  confirmAccess,
  rememberConversationAccess: true,
  emit: (event: AppEvent) => win?.webContents.send('aio:event', event),
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win ?? undefined!, { properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
});
const mobileSessionFile = path.join(configDir(), 'mobile-session.enc');
const mobile = new MobileGateway(service, {
  load: async () => {
    if (!safeStorage.isEncryptionAvailable() || !existsSync(mobileSessionFile)) return undefined;
    return JSON.parse(safeStorage.decryptString(await readFile(mobileSessionFile)));
  },
  save: async (value) => {
    if (!value) return rm(mobileSessionFile, { force: true });
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('O armazenamento seguro do sistema está indisponível para salvar o pareamento.');
    }
    await mkdir(path.dirname(mobileSessionFile), { recursive: true });
    const temporary = `${mobileSessionFile}.tmp`;
    try {
      await writeFile(temporary, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
      await rename(temporary, mobileSessionFile);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  },
});
app.on('before-quit', () => mobile.shutdown());

/** Only our own page may call the API; anything else loaded into the window (it should never be) is ignored. */
function fromOurPage(event: IpcMainInvokeEvent): boolean {
  return event.sender === win?.webContents && (event.senderFrame?.url === pageUrl || event.senderFrame?.url.startsWith(`${pageUrl}#`) === true);
}

for (const method of API_METHODS) {
  ipcMain.handle(`aio:${method}`, (event, ...args: unknown[]) => {
    if (!fromOurPage(event)) throw new Error('Blocked: unknown sender');
    return (service[method] as (...a: unknown[]) => unknown)(...args);
  });
}

ipcMain.handle('aio:writeClipboardText', (event, text: unknown) => {
  if (!fromOurPage(event) || typeof text !== 'string' || text.length > 4_000_000) throw new Error('Não foi possível copiar o texto.');
  return clipboard.writeText(text);
});

ipcMain.handle('aio:mobileAccess', (event, command: unknown) => {
  if (!fromOurPage(event) || (command !== undefined && command !== 'pair' && command !== 'stop' && command !== 'allow-prompts' && command !== 'block-prompts')) throw new Error('Acesso pelo celular indisponível.');
  return mobile.manage(command);
});

ipcMain.handle('aio:downloadAndroid', (event) => {
  if (!fromOurPage(event)) throw new Error('Download indisponível.');
  return shell.openExternal(ANDROID_DOWNLOAD);
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: process.env.AIO_DEMO === '1' ? 'Big Three · Demonstração' : 'Big Three',
    icon: path.join(here, '..', 'renderer', 'icon.png'),
    // Matches the page's own background so there is no white flash while it loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1218' : '#f4f6fb',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.removeMenu();
  if (process.env.AIO_DEMO === '1') win.once('ready-to-show', () => { win?.show(); win?.restore(); win?.focus(); });
  browser.attach(win);
  // The page never needs to open windows or leave itself.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(pageUrl)) e.preventDefault();
  });
  win.on('closed', () => {
    win = null;
  });
  void win.loadURL(pageUrl);
}

if (process.env.AIO_DEMO !== '1' && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  void app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.marcj19.bigthree');
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    void mobile.restore().catch(() => {});
    createWindow();
    if (installed) setTimeout(() => void updates.perform('check'), 3000).unref();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
