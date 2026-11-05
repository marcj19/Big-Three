import { WebContentsView, session, type BrowserWindow } from 'electron';
import type { BrowserBounds, BrowserState } from '../shared/api.js';
import { browserUrl, isBrowserUrl } from '../shared/browser-url.js';

/** Native web content has its own session and never receives the orchestrator's preload or IPC bridge. */
export class EmbeddedBrowser {
  private view?: WebContentsView;
  private owner?: BrowserWindow;
  private error?: string;
  private requested: BrowserBounds = { visible: false, x: 0, y: 0, width: 0, height: 0 };
  constructor(private readonly emit: (state: BrowserState) => void) {}
  attach(owner: BrowserWindow): void {
    this.owner = owner;
    owner.on('resize', () => this.bounds(this.requested));
    owner.once('closed', () => { this.view?.webContents.close(); this.view = undefined; this.owner = undefined; });
  }
  state(): BrowserState {
    const contents = this.view?.webContents;
    return { supported: true, url: contents?.getURL() ?? '', title: contents?.getTitle() ?? '', loading: contents?.isLoading() ?? false,
      canBack: contents?.navigationHistory.canGoBack() ?? false, canForward: contents?.navigationHistory.canGoForward() ?? false, error: this.error };
  }
  private publish(): void { if (this.owner && !this.owner.isDestroyed()) this.emit(this.state()); }
  private ensure(): WebContentsView {
    if (this.view) return this.view;
    if (!this.owner || this.owner.isDestroyed()) throw new Error('A janela do app não está disponível.');
    const browsingSession = session.fromPartition('persist:aio-workbench-browser');
    browsingSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browsingSession.setPermissionCheckHandler(() => false);
    const view = new WebContentsView({ webPreferences: { session: browsingSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    this.view = view;
    this.owner.contentView.addChildView(view);
    view.setVisible(false);
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => { if (isBrowserUrl(url)) void this.navigate(url); return { action: 'deny' }; });
    contents.on('will-frame-navigate', (event) => { if (!isBrowserUrl(event.url)) event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!isBrowserUrl(url)) event.preventDefault(); });
    contents.on('did-start-loading', () => this.publish());
    contents.on('did-stop-loading', () => this.publish());
    contents.on('did-navigate', () => this.publish());
    contents.on('did-navigate-in-page', () => this.publish());
    contents.on('page-title-updated', () => this.publish());
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) { this.error = 'A página não pôde ser carregada. Confira o endereço e a conexão.'; this.publish(); }
    });
    contents.on('render-process-gone', () => { this.error = 'A página foi encerrada. Recarregue para continuar.'; this.publish(); });
    this.bounds(this.requested);
    return view;
  }
  async navigate(input: string): Promise<void> {
    const url = browserUrl(input); this.error = undefined;
    const view = this.ensure();
    try { await view.webContents.loadURL(url); }
    catch { if (!this.error) this.error = 'Não foi possível abrir esta página.'; }
    this.publish();
  }
  command(command: 'back' | 'forward' | 'reload' | 'stop'): void {
    const contents = this.view?.webContents;
    if (!contents) return;
    this.error = undefined;
    if (command === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (command === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (command === 'reload') contents.reload();
    else if (command === 'stop') contents.stop();
    this.publish();
  }
  bounds(bounds: BrowserBounds): void {
    this.requested = bounds;
    if (!this.view || !this.owner || this.owner.isDestroyed()) return;
    const [width = 0, height = 0] = this.owner.getContentSize();
    const zoom = this.owner.webContents.getZoomFactor();
    const x = Math.min(width, Math.round(bounds.x * zoom)), y = Math.min(height, Math.round(bounds.y * zoom));
    this.view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width * zoom))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height * zoom))) });
    this.view.setVisible(bounds.visible && bounds.width > 0 && bounds.height > 0);
  }
}
