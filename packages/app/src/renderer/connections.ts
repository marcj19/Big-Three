import type { ConnectionInput, ConnectionView, Engine } from '../shared/api.js';
import { api } from './bridge.js';
import { h } from './dom.js';
import { engineMark, icon } from './icons.js';
import { state } from './state.js';
import { confirmDialog, openDialog, toast } from './ui.js';

const ENGINES: { value: Engine; label: string; port: number; dbLabel: string; dbHint: string }[] = [
  { value: 'postgres', label: 'PostgreSQL', port: 5432, dbLabel: 'Banco de dados', dbHint: 'ex.: meu_banco' },
  { value: 'mysql', label: 'MySQL', port: 3306, dbLabel: 'Banco de dados', dbHint: 'ex.: meu_banco' },
  { value: 'oracle', label: 'Oracle', port: 1521, dbLabel: 'Service name', dbHint: 'ex.: ORCLPDB1' },
];
const engineInfo = (e: Engine) => ENGINES.find((x) => x.value === e)!;

const blank = (): ConnectionInput => ({ name: '', engine: 'postgres', host: 'localhost', port: 5432, database: '', user: '', ssl: false });
const toInput = (c: ConnectionView): ConnectionInput => ({ name: c.name, engine: c.engine, host: c.host, port: c.port, database: c.database, user: c.user, ssl: c.ssl });

type Result = { kind: 'ok' | 'bad' | 'busy'; text: string } | undefined;

/** Add, test and remove database connections. Passwords go to the vault and are never shown back. */
export function openConnectionsDialog(onChange: () => Promise<void>): void {
  let selected: string | undefined = state.connections[0]?.name;
  let isNew = state.connections.length === 0;
  let draft: ConnectionInput = state.connections[0] ? toInput(state.connections[0]) : blank();
  let password = '';
  let showPassword = false;
  let result: Result;

  openDialog({
    label: 'Bancos de dados',
    build: (close) => {
      const root = h('div', { class: 'conn-layout' });

      const refresh = async () => {
        await onChange();
        render();
      };

      function render() {
        const saved = isNew ? undefined : state.connections.find((c) => c.name === selected);
        const engine = engineInfo(draft.engine);

        const side = h(
          'div',
          { class: 'conn-side' },
          h('h2', {}, 'Bancos de dados'),
          ...state.connections.map((c) =>
            h(
              'button',
              {
                class: 'conn-item',
                type: 'button',
                'aria-current': !isNew && c.name === selected ? 'true' : undefined,
                onClick: () => {
                  selected = c.name;
                  isNew = false;
                  draft = toInput(c);
                  password = '';
                  result = undefined;
                  render();
                },
              },
              h('span', { class: 'tile' }, engineMark(c.engine)),
              h('span', {}, h('div', { class: 'nm' }, c.name), h('div', { class: 'sub' }, `${engineInfo(c.engine).label} · ${c.hasPassword ? 'senha guardada' : 'sem senha'}`)),
            ),
          ),
          h(
            'button',
            {
              class: 'btn tonal',
              type: 'button',
              onClick: () => {
                isNew = true;
                selected = undefined;
                draft = blank();
                password = '';
                result = undefined;
                render();
              },
            },
            icon('plus', 'sm'),
            'Nova conexão',
          ),
        );

        const text = (label: string, key: 'name' | 'host' | 'database' | 'user', opts: { disabled?: boolean; placeholder?: string; wide?: boolean } = {}) =>
          h(
            'label',
            { class: `field${opts.wide ? ' wide' : ''}` },
            label,
            h('input', {
              value: draft[key] ?? '',
              disabled: opts.disabled,
              placeholder: opts.placeholder,
              autocomplete: 'off',
              spellcheck: 'false',
              onInput: (e: Event) => (draft[key] = (e.target as HTMLInputElement).value),
            }),
          );

        const pwInput = h('input', {
          type: showPassword ? 'text' : 'password',
          value: password,
          autocomplete: 'new-password',
          placeholder: saved?.hasPassword ? 'Guardada — digite só para trocar' : 'Senha do usuário',
          onInput: (e: Event) => (password = (e.target as HTMLInputElement).value),
        });

        async function save(): Promise<boolean> {
          try {
            await api.saveConnection({ ...draft, name: draft.name.trim(), port: draft.port || undefined });
            if (password) await api.setPassword(draft.name.trim(), password);
            password = '';
            selected = draft.name.trim();
            isNew = false;
            return true;
          } catch (err) {
            result = { kind: 'bad', text: (err as Error).message };
            render();
            return false;
          }
        }

        const engines = h(
          'div',
          { class: 'engines', role: 'radiogroup', 'aria-label': 'Tipo de banco' },
          ...ENGINES.map((e) =>
            h(
              'button',
              {
                class: 'engine',
                type: 'button',
                role: 'radio',
                'aria-checked': String(draft.engine === e.value),
                onClick: () => {
                  if (!draft.port || draft.port === engine.port) draft.port = e.port;
                  draft.engine = e.value;
                  render();
                },
              },
              h('span', { class: 'tile lg' }, engineMark(e.value)),
              e.label,
            ),
          ),
        );

        const form = h(
          'div',
          { class: 'dialog-pad' },
          h('h2', {}, isNew ? 'Nova conexão' : draft.name),
          engines,
          h(
            'div',
            { class: 'fields' },
            text('Nome (sem espaços)', 'name', { disabled: !isNew, placeholder: 'ex.: vendas' }),
            text('Servidor', 'host', { placeholder: 'localhost' }),
            h(
              'label',
              { class: 'field' },
              'Porta',
              h('input', { type: 'number', value: draft.port ?? '', min: '1', max: '65535', onInput: (e: Event) => (draft.port = Number((e.target as HTMLInputElement).value) || undefined) }),
            ),
            text(engine.dbLabel, 'database', { placeholder: engine.dbHint }),
            text('Usuário', 'user', { placeholder: 'um usuário só com SELECT' }),
            h(
              'label',
              { class: 'field' },
              'Senha',
              h(
                'span',
                { class: 'with-btn' },
                pwInput,
                h(
                  'button',
                  { class: 'icon-btn sm', type: 'button', 'aria-label': showPassword ? 'Esconder a senha' : 'Mostrar a senha', 'aria-pressed': String(showPassword), onClick: () => { showPassword = !showPassword; pwInput.type = showPassword ? 'text' : 'password'; render(); } },
                  icon(showPassword ? 'eyeoff' : 'eye', 'sm'),
                ),
              ),
            ),
          ),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: draft.ssl === true, onChange: (e: Event) => (draft.ssl = (e.target as HTMLInputElement).checked) }), 'Usar conexão segura (SSL)'),
          h(
            'div',
            { class: 'note' },
            icon('shield'),
            h(
              'span',
              {},
              'A senha vai direto para o cofre do Windows (Credential Manager) e nunca é mostrada de volta nem enviada aos modelos. Use um usuário do banco que só tenha permissão de SELECT: é essa a proteção que vale mesmo se algo der errado.',
            ),
          ),
          result
            ? h('div', { class: `result ${result.kind}`, role: result.kind === 'bad' ? 'alert' : 'status' }, icon(result.kind === 'ok' ? 'check' : result.kind === 'bad' ? 'alert' : 'spinner', result.kind === 'busy' ? 'sm spin' : 'sm'), result.text)
            : '',
          h(
            'div',
            { class: 'row-end' },
            saved
              ? h(
                  'button',
                  {
                    class: 'btn danger',
                    type: 'button',
                    onClick: async () => {
                      if (!(await confirmDialog({ title: 'Remover conexão?', message: `"${saved.name}" e a senha guardada serão removidas deste computador.`, confirm: 'Remover', danger: true }))) return;
                      await api.deleteConnection(saved.name);
                      await onChange();
                      selected = state.connections[0]?.name;
                      isNew = state.connections.length === 0;
                      draft = state.connections[0] ? toInput(state.connections[0]) : blank();
                      result = undefined;
                      render();
                    },
                  },
                  icon('trash', 'sm'),
                  'Remover',
                )
              : '',
            saved?.hasPassword
              ? h(
                  'button',
                  {
                    class: 'btn',
                    type: 'button',
                    onClick: async () => {
                      await api.clearPassword(saved.name);
                      result = { kind: 'ok', text: 'Senha apagada do cofre.' };
                      await refresh();
                    },
                  },
                  'Apagar senha',
                )
              : '',
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', type: 'button', onClick: close }, 'Fechar'),
            h(
              'button',
              {
                class: 'btn tonal',
                type: 'button',
                onClick: async () => {
                  if (await save()) {
                    result = { kind: 'ok', text: 'Salvo.' };
                    toast('Conexão salva.', 'success');
                    await refresh();
                  }
                },
              },
              'Salvar',
            ),
            h(
              'button',
              {
                class: 'btn primary',
                type: 'button',
                onClick: async () => {
                  if (!(await save())) return;
                  await onChange();
                  result = { kind: 'busy', text: 'Testando a conexão…' };
                  render();
                  const t = await api.testConnection(draft.name.trim());
                  result = t.ok ? { kind: 'ok', text: `Conectou. ${t.tables} tabela${t.tables === 1 ? '' : 's'} ${t.tables === 1 ? 'visível' : 'visíveis'} para este usuário.` } : { kind: 'bad', text: t.error ?? 'Não foi possível conectar.' };
                  await refresh();
                },
              },
              'Salvar e testar',
            ),
          ),
        );
        root.replaceChildren(side, form);
      }
      render();
      return root;
    },
  });
}
