import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configDir } from '@aio/db-broker';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, type IpcMainInvokeEvent } from 'electron';
import { AppService } from '../services/app-service.js';
import { API_METHODS, type AppEvent } from '../shared/api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(path.join(here, '..', 'renderer', 'index.html')).href;

let win: BrowserWindow | null = null;

const confirmAccess = async ({ access, cwd, summary }: { access: 'edit' | 'full'; cwd: string; summary: string }) => {
  const full = access === 'full';
  const { response } = await dialog.showMessageBox(win ?? undefined!, {
    type: 'warning',
    buttons: ['Cancelar', full ? 'Permitir acesso total' : 'Permitir edição'],
    defaultId: 0,
    cancelId: 0,
    title: 'Permitir que o modelo altere arquivos?',
    message: full ? 'Acesso TOTAL: o modelo pode rodar comandos e alterar arquivos sem pedir.' : 'O modelo poderá criar e editar arquivos.',
    detail: `${summary}\n\nPasta: ${cwd}`,
  });
  return response === 1;
};

const service = new AppService({
  configDir: configDir(),
  confirmAccess,
  emit: (event: AppEvent) => win?.webContents.send('aio:event', event),
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win ?? undefined!, { properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
});

/** Only our own page may call the API; anything else loaded into the window (it should never be) is ignored. */
function fromOurPage(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url === pageUrl || event.senderFrame?.url.startsWith(`${pageUrl}#`) === true;
}

for (const method of API_METHODS) {
  ipcMain.handle(`aio:${method}`, (event, ...args: unknown[]) => {
    if (!fromOurPage(event)) throw new Error('Blocked: unknown sender');
    return (service[method] as (...a: unknown[]) => unknown)(...args);
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Big Three',
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
