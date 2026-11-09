import type { AccountQuota } from '../shared/api.js';
import { api } from './bridge.js';
import { ctx } from './ctx.js';
import { h, keepFocus } from './dom.js';
import { icon, providerMark } from './icons.js';
import { windowLabel } from './quota-format.js';
import { NAMES, PROVIDERS, provider, state } from './state.js';
import { openDialog } from './ui.js';

const HELP = {
  codex: { url: 'https://chatgpt.com/codex/settings/usage', label: 'Abrir uso do Codex', command: '/status', terminal: 'codex' },
  claude: { url: 'https://claude.ai/settings/usage', label: 'Abrir uso do Claude', command: '/usage', terminal: 'claude' },
  gemini: { url: 'https://antigravity.google/docs/cli/commands/usage', label: 'Como consultar no Antigravity', command: '/usage', terminal: 'agy' },
};
const date = (value: number) => new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function openQuotas(): void {
  let quotas: AccountQuota[] = [], loading = false, error = '', closed = false;
  const body = h('div', { class: 'quota-grid' });
  const status = h('p', { class: 'muted small', role: 'status' });
  const refresh = h('button', { class: 'btn tonal', type: 'button', 'data-fk': 'refresh-quotas', onClick: () => void load() }, icon('refresh', 'sm'), 'Atualizar');
  const render = () => {
    refresh.disabled = loading;
    status.textContent = error || (loading ? 'Consultando limites disponíveis…' : 'Consultas de conta têm cache de até 1 minuto. Dados da CLI são atualizados nas execuções.');
    keepFocus(body, () => body.replaceChildren(...PROVIDERS.map((id) => {
      const quota = quotas.find((entry) => entry.provider === id), usage = state.usage[id];
      const available = provider(id)?.available;
      const help = HELP[id];
      const limited = usage?.limitedUntil && usage.limitedUntil > Date.now();
      const windows = quota?.windows ?? [];
      return h('section', { class: 'quota-card', 'aria-label': `Limites de ${NAMES[id]}` },
        h('div', { class: 'quota-card-head' }, h('span', { class: 'avatar' }, providerMark(id)), h('h3', {}, NAMES[id]),
          h('span', { class: `quota-source${limited ? ' limited' : ''}` }, !available ? 'Não instalado' : quota?.source === 'account' ? 'Conta' : quota?.source === 'events' ? 'Observado na CLI' : 'Sem leitura de cota')),
        h('p', { class: 'quota-description' }, !available ? 'Instale e conecte a CLI para acompanhar o uso.' : quota?.message ?? (loading ? 'Verificando…' : 'Cota ainda não consultada.')),
        ...windows.map((window) => {
          const expired = window.resetsAt !== undefined && window.resetsAt <= Date.now();
          const percent = expired ? undefined : window.usedPercent;
          const label = windowLabel(window.name);
          const value = percent === undefined ? expired ? 'Aguardando atualização' : window.status === 'rejected' ? 'Limite atingido' : window.status === 'allowed_warning' ? 'Próximo do limite' : 'Percentual não informado' : `${Math.round(percent)}% usado · ${Math.round(100 - percent)}% restante`;
          return h('div', { class: `quota-window${expired ? ' stale' : ''}` }, h('div', { class: 'quota-window-label' }, h('b', {}, label), h('span', {}, value)),
            percent !== undefined ? h('progress', { max: 100, value: percent, class: percent >= 90 ? 'high' : '', 'aria-label': `${label}: ${Math.round(percent)}% usado` }) : '',
            window.resetsAt ? h('p', {}, `${expired ? 'Renovação prevista em' : 'Renova em'} ${date(window.resetsAt)}`) : '',
            window.observedAt ? h('p', {}, `Observado em ${date(window.observedAt)}`) : '');
        }),
        quota?.checkedAt ? h('p', { class: 'quota-updated' }, `Última leitura: ${date(quota.checkedAt)}`) : '',
        limited ? h('p', { class: 'quota-pause' }, `Pausa do orquestrador até ${date(usage!.limitedUntil!)}. Este horário pode ser uma espera local após erro, e não a renovação da conta.`) : '',
        h('div', { class: 'quota-local' }, h('b', {}, 'Nesta sessão do app'), h('span', {}, `${usage?.turns ?? 0} turnos · ${((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)).toLocaleString('pt-BR')} tokens processados${usage?.turns ? ` (cerca de ${Math.round(((usage.inputTokens) + (usage.outputTokens)) / usage.turns).toLocaleString('pt-BR')} por turno)` : ''}`),
          h('span', {}, 'Entrada e saída, incluindo o cache de prompt. Contagem local: não mede a porcentagem da assinatura.')),
        h('p', { class: 'quota-cli' }, 'No terminal, abra ', h('code', {}, help.terminal), ' e use ', h('code', {}, help.command), '.'),
        h('button', { class: 'btn text', type: 'button', 'data-fk': `quota-help-${id}`, onClick: () => { dialog.close(); ctx.openBrowser(help.url); } }, help.label));
    })));
  };
  const load = async () => {
    if (loading || closed) return;
    loading = true; error = ''; render();
    try {
      const [result, usage] = await Promise.all([api.accountQuotas(), api.usage()]);
      state.quotas = result;
      if (!closed) { quotas = result; state.usage = usage; ctx.renderSidebar(); }
    } catch { error = 'Não foi possível atualizar. Tente novamente ou consulte a plataforma.'; }
    finally { loading = false; if (!closed) render(); }
  };
  const dialog = openDialog({ label: 'Limites e uso', onClose: () => { closed = true; }, build: (close) => h('div', { class: 'dialog-pad quota-dialog' },
    h('div', { class: 'quota-title' }, h('div', {}, h('h2', {}, 'Limites e uso'), h('p', { class: 'muted' }, 'Acompanhe a cota da conta e o uso do orquestrador.')), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar limites e uso', onClick: close }, icon('x'))),
    h('div', { class: 'quota-toolbar' }, refresh, status), body) });
  void load();
}
