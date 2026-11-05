import { appendFile } from 'node:fs/promises';
import type { Adapter, AgentEvent, ProviderId, RunRequest } from '@aio/core';
import { fileActivitySink, type PeerActivity } from '@aio/room';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pretend models for trying the interface without spending any subscription quota. Codex is shown as not
 * installed on purpose, so the "unavailable" state of the window gets exercised too.
 */
export function demoAdapters(): Record<ProviderId, Adapter> {
  const make = (id: ProviderId, displayName: string, opts: { installed: boolean; mcp: boolean }): Adapter => ({
    id,
    displayName,
    supportsResume: false,
    supportsMcp: opts.mcp,
    efforts: id === 'gemini' ? [] : ['low', 'medium', 'high', 'xhigh', 'max'],
    listModels: async () => [
      { id: '', label: 'Padrão da conta' },
      ...(id === 'gemini'
        ? [
            { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
            { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
            { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
          ]
        : [
            { id: 'opus', label: 'Opus', note: 'o mais recente' },
            { id: 'sonnet', label: 'Sonnet', note: 'o mais recente' },
            { id: 'claude-opus-5-5', label: 'Opus 5.5' },
            { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
          ]),
    ],
    canLogin: id === 'claude',
    detect: async () => (opts.installed ? { available: true, version: 'demo' } : { available: false, reason: `${displayName} CLI not found. Install it and sign in.` }),
    authStatus: async () => ({ signedIn: opts.installed }),
    async *login() {
      yield { type: 'output', line: 'Abrindo o navegador…' };
      await sleep(300);
      yield { type: 'done', ok: true };
    },
    async *run(req: RunRequest): AsyncGenerator<AgentEvent, void> {
      yield { type: 'session', sessionId: `${id}-demo` };
      if (req.mcpServers?.length) yield { type: 'tool_call', name: `mcp__${req.mcpServers[0]!.name}__list_schema` };
      // Pretend to consult a colleague, the way the real room server records it, when the user asks for one.
      const room = req.mcpServers?.find((s) => s.name === 'room');
      const peers = room?.env?.AIO_ROOM_PEERS?.split(',').filter(Boolean) ?? [];
      const activitySink = room?.env?.AIO_ROOM_ACTIVITY_FILE ? fileActivitySink(room.env.AIO_ROOM_ACTIVITY_FILE) : undefined;
      const peerActivity = (activity: PeerActivity['activity']) => {
        if (peers[0]) activitySink?.({ self: id, peer: peers[0] as ProviderId, activity });
      };
      if (/escrit[oó]rio|anima[çc]|demonstra[çc]/i.test(req.prompt)) {
        for (const name of ['read_file', 'apply_patch', 'exec_command']) {
          if (req.signal?.aborted) { yield { type: 'done', status: 'cancelled' }; return; }
          yield { type: 'tool_call', name }; await sleep(1800);
        }
      }
      if (room?.env?.AIO_ROOM_FILE && peers[0] && /colega|gemini|codex|revis/i.test(req.prompt.split('YOUR TURN')[0]?.split('\n').slice(-6).join(' ') ?? '')) {
        yield { type: 'tool_call', name: 'mcp__room__ask_peer' };
        await sleep(400);
        const line = (author: string, text: string) => JSON.stringify({ author, text, at: new Date().toISOString() }) + '\n';
        await appendFile(room.env.AIO_ROOM_FILE, line(id, `(to ${peers[0]}) Pode revisar criticamente esta resposta?`));
        peerActivity('thinking');
        await sleep(1800);
        peerActivity('writing');
        await sleep(1200);
        await appendFile(room.env.AIO_ROOM_FILE, line(peers[0], 'Revisão simulada: a resposta está correta, só falta citar um exemplo.'));
        peerActivity('done');
      }
      const review = req.prompt.includes('VERDICT');
      const formatted = /tabela|harness|formata[çc]/i.test(req.prompt);
      const text = formatted ? [
        '### Trabalho da equipe', '', '**A tarefa foi organizada em etapas para facilitar a revisão.**', '',
        '| Etapa | Responsável | Resultado |', '|---|---|---|', '| Entender o projeto | Claude | Estrutura analisada |', '| Revisar a proposta | Gemini | Sugestões incorporadas |', '| Conferir a entrega | Equipe | Pronto para revisão |', '',
        '#### Próximos passos', '', '1. Conferir os arquivos alterados.', '   - Ler o código e os comentários.', '   - Verificar as dependências.', '2. Validar a prévia no navegador integrado.', '',
        '- [x] Estrutura organizada', '- [x] Revisão do colega recebida', '- [ ] Sua revisão final', '',
        '```ts', 'const equipe = ["claude", "gemini", "codex"];', 'for (const ia of equipe) {', '  console.log(`Olá, ${ia}`);', '}', '```', '',
        '[Abrir uma página de exemplo](https://example.com/)', '', '> Esta resposta usa modelos de demonstração e não consome cota.',
      ].join('\n') :
        `[${displayName}, simulado${req.model ? ` · ${req.model}` : ''}${req.effort ? ` · esforço ${req.effort}` : ''}] Recebi: "${req.prompt.split('YOUR TURN')[1]?.trim().slice(0, 70) ?? ''}"\n\n` +
        'Exemplo de código:\n```ts\nconst x = 1;\n```\n' +
        (review ? '\nVERDICT: APPROVE' : '');
      for (const word of text.split(/(\s+)/)) {
        if (req.signal?.aborted) {
          yield { type: 'done', status: 'cancelled' };
          return;
        }
        yield { type: 'text', text: word, partial: true };
        await sleep(15);
      }
      yield { type: 'usage', inputTokens: 120, outputTokens: 40 };
      if (id === 'claude') yield { type: 'limit', status: 'allowed', window: 'five_hour', resetsAt: Date.now() + 3 * 3600_000 };
      yield { type: 'done', status: 'ok', text };
    },
  });
  return {
    claude: make('claude', 'Claude', { installed: true, mcp: true }),
    gemini: make('gemini', 'Gemini (Antigravity)', { installed: true, mcp: false }),
    codex: make('codex', 'Codex', { installed: false, mcp: true }),
  };
}
