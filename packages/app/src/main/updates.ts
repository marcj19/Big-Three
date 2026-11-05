import type { AppUpdater } from 'electron-updater';
import type { UpdateCommand, UpdateState } from '../shared/api.js';

export class AppUpdates {
  private current: UpdateState;

  constructor(version: string, private readonly updater: AppUpdater | undefined, private readonly emit: (state: UpdateState) => void) {
    this.current = { version, phase: updater ? 'idle' : 'unavailable' };
    if (!updater) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;

    updater.on('update-available', (info) => this.set({ phase: 'available', availableVersion: info.version }));
    updater.on('update-not-available', () => this.set({ phase: 'current' }));
    updater.on('download-progress', ({ percent }) => {
      this.set({ phase: 'downloading', availableVersion: this.current.availableVersion, percent: Math.max(0, Math.min(100, Math.round(percent))) });
    });
    updater.on('update-downloaded', (info) => this.set({ phase: 'ready', availableVersion: info.version }));
    updater.on('error', (error) => this.fail(error));
  }

  state(): UpdateState { return { ...this.current }; }

  async perform(command: UpdateCommand): Promise<UpdateState> {
    const updater = this.updater;
    if (!updater) return this.state();
    const phase = this.current.phase;
    try {
      if (command === 'check' && !['checking', 'downloading', 'ready', 'installing'].includes(phase)) {
        this.set({ phase: 'checking' });
        const result = await updater.checkForUpdates();
        if (!result && this.current.phase === 'checking') this.set({ phase: 'unavailable' });
      } else if (command === 'download' && phase === 'available') {
        this.set({ phase: 'downloading', availableVersion: this.current.availableVersion, percent: 0 });
        await updater.downloadUpdate();
      } else if (command === 'install' && phase === 'ready') {
        this.set({ phase: 'installing', availableVersion: this.current.availableVersion });
        updater.quitAndInstall(true, true);
      }
    } catch (error) {
      this.fail(error);
    }
    return this.state();
  }

  private set(state: Omit<UpdateState, 'version'>): void {
    this.current = { ...state, version: this.current.version };
    this.emit(this.state());
  }

  private fail(error: unknown): void {
    if (this.current.phase === 'error') return;
    const code = (error as { code?: string } | undefined)?.code;
    this.set({ phase: 'error', message: code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'
      ? 'Ainda não há uma versão publicada no GitHub Releases.'
      : 'Não foi possível concluir a atualização. Tente verificar novamente.' });
  }
}
