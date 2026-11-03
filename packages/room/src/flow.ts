import type { Access, ProviderId } from '@aio/core';
import { parseVerdict, type PatternOptions, type PatternResult, type Verdict } from './patterns.js';
import { NAMES } from './prompt.js';
import type { Room } from './room.js';
import type { TurnOptions, TurnResult } from './types.js';

/**
 * A flow is a list of steps run in order, each with its own model. The old "review", "plan and execute" and "debate"
 * patterns are just particular lists of steps; a person can now build any other.
 */
export type StepKind = 'answer' | 'plan' | 'execute' | 'review' | 'revise' | 'debate';

export const STEP_LABEL: Record<StepKind, string> = {
  answer: 'Resposta',
  plan: 'Plano',
  execute: 'Execução',
  review: 'Revisão',
  revise: 'Correção',
  debate: 'Debate',
};

export interface FlowMember {
  provider: ProviderId;
  model?: string;
  effort?: string;
}

export interface FlowStep {
  kind: StepKind;
  /** Who does the step. For a debate, who closes it with the synthesis. */
  provider: ProviderId;
  model?: string;
  effort?: string;
  /** Required for `execute`: whether the model may change files is always the caller's explicit decision. */
  access?: Access;
  /** `debate` only: who takes part (at least two different providers). */
  members?: FlowMember[];
  /** `debate` only: rounds of answering, the first one independent. */
  rounds?: number;
  /** Tried in this order when `provider` cannot answer (limit reached, signed out). */
  fallback?: ProviderId[];
}

export type StepStatus = 'running' | 'done' | 'skipped' | 'error' | 'cancelled';

export interface StepEvent {
  index: number;
  total: number;
  kind: StepKind;
  provider: ProviderId;
  status: StepStatus;
  /** Why a step was skipped, or a short result. */
  note?: string;
  error?: string;
}

export interface FlowInput extends PatternOptions {
  task: string;
  steps: FlowStep[];
  onStep?: (event: StepEvent) => void;
}

const MAX_STEPS = 8;
const PRODUCES: ReadonlySet<StepKind> = new Set(['answer', 'execute', 'revise', 'debate']);
const VERDICT_LINE = 'Finish with exactly one line: `VERDICT: APPROVE` if it can be used as it is, otherwise `VERDICT: CHANGES`.';

/** Returns a readable problem with the list of steps, or undefined when it can run. */
export function validateFlow(steps: FlowStep[]): string | undefined {
  if (steps.length === 0) return 'Adicione pelo menos uma etapa.';
  if (steps.length > MAX_STEPS) return `Um fluxo pode ter no máximo ${MAX_STEPS} etapas.`;
  let producer: ProviderId | undefined;
  for (const [i, s] of steps.entries()) {
    const where = `Etapa ${i + 1} (${STEP_LABEL[s.kind]})`;
    if (s.kind === 'execute' && s.access === undefined) return `${where}: diga o que o modelo pode fazer (ler, editar ou acesso total).`;
    if (s.kind === 'debate') {
      const distinct = new Set((s.members ?? []).map((m) => m.provider));
      if (distinct.size < 2) return `${where}: um debate precisa de pelo menos dois modelos diferentes.`;
    }
    if (s.kind === 'review' || s.kind === 'revise') {
      if (!producer) return `${where}: não há nada antes para ${s.kind === 'review' ? 'revisar' : 'corrigir'}. Coloque uma resposta, execução ou debate antes.`;
      if (s.kind === 'review' && s.provider === producer) return `${where}: o revisor precisa ser outro modelo, diferente de quem fez o trabalho.`;
    }
    if (PRODUCES.has(s.kind)) producer = s.provider;
  }
  return undefined;
}

export async function runFlow(room: Room, input: FlowInput): Promise<PatternResult> {
  const problem = validateFlow(input.steps);
  if (problem) return { status: 'error', final: '', steps: [], error: problem };

  const steps: TurnResult[] = [];
  const total = input.steps.length;
  let producer: ProviderId | undefined;
  let verdict: Verdict | undefined; // what the latest review said about the work that is still current
  let lastVerdict: Verdict | undefined; // reported at the end
  let final = '';

  const base = (): TurnOptions => ({ cwd: input.cwd, signal: input.signal, timeoutMs: input.timeoutMs, withPeerTools: input.withPeerTools, mcpServers: input.mcpServers });
  const emit = (index: number, step: FlowStep, status: StepStatus, extra: Partial<StepEvent> = {}) =>
    input.onStep?.({ index, total, kind: step.kind, provider: step.provider, status, ...extra });
  const fail = (index: number, step: FlowStep, r: TurnResult): PatternResult => {
    if (r.status === 'cancelled') {
      emit(index, step, 'cancelled');
      return { status: 'cancelled', final: '', steps };
    }
    emit(index, step, 'error', { error: r.error });
    return { status: 'error', final: '', steps, error: r.error };
  };

  await room.say(input.task);

  for (const [index, step] of input.steps.entries()) {
    if (input.signal?.aborted) return { status: 'cancelled', final: '', steps };

    if (step.kind === 'revise' && verdict === 'approve') {
      emit(index, step, 'skipped', { note: 'O revisor aprovou, então não há o que corrigir.' });
      continue;
    }
    emit(index, step, 'running');
    const detail = step.model ? ` · ${step.model}` : '';
    await room.transcript.append({ author: 'system', text: `Etapa ${index + 1} de ${total} · ${STEP_LABEL[step.kind]} · ${NAMES[step.provider]}${detail}` });

    const candidates = [step.provider, ...(step.fallback ?? [])];
    const own: TurnOptions = { ...base(), model: step.model, effort: step.effort };
    // The chosen model belongs to the chosen provider; if another one ends up first, it uses its own default.
    const asFor = (first: ProviderId): TurnOptions => (first === step.provider ? own : { ...own, model: undefined, effort: undefined });
    let result: TurnResult;

    switch (step.kind) {
      case 'answer':
        result = await room.turn(candidates, "Answer the user's latest message.", { ...own, access: 'read-only' });
        break;
      case 'plan':
        result = await room.turn(
          candidates,
          "Write a short numbered plan for the user's latest request: the steps, the files involved and the risks. Do not change anything and do not carry the plan out.",
          { ...own, access: 'read-only' },
        );
        break;
      case 'execute':
        result = await room.turn(
          candidates,
          "Do what the user asked, following the latest plan in the transcript if there is one. Follow it unless it is wrong, and say so if you deviate. Report what you changed and anything you could not do.",
          { ...own, access: step.access },
        );
        break;
      case 'review': {
        const reviewers = candidates.filter((p) => p !== producer);
        if (reviewers.length === 0) {
          const error = `O revisor precisa ser outro modelo, diferente de ${NAMES[producer!]}.`;
          emit(index, step, 'error', { error });
          return { status: 'error', final: '', steps, error };
        }
        result = await room.turn(
          reviewers,
          `Review ${NAMES[producer!]}'s latest answer or work critically. Check its claims against the actual code or files when it refers to them. ` +
            `List concrete problems, most important first, each with why it matters and how to fix it, and say what is already right. ${VERDICT_LINE}`,
          { ...asFor(reviewers[0]!), access: 'read-only' },
        );
        if (result.status === 'ok') verdict = lastVerdict = parseVerdict(result.text);
        break;
      }
      case 'revise':
        result = await room.turn(
          candidates,
          'The reviewer looked at your latest work. Fix every valid point and say briefly which points you rejected and why. Give the complete corrected result.',
          { ...own, access: 'read-only' },
        );
        break;
      case 'debate': {
        const members = step.members ?? [];
        let active = members;
        const rounds = Math.max(1, step.rounds ?? 2);
        for (let r = 1; r <= rounds; r++) {
          const instruction =
            r === 1
              ? "Answer the user's question on your own. Be concrete and say how sure you are."
              : "Read the other participants' latest answers. Say where you agree, where you disagree and why, concede what they got right, and give your updated answer.";
          const results = await room.round(active.map((m) => ({ provider: m.provider, instruction, options: { ...base(), access: 'read-only' as const, model: m.model, effort: m.effort } })));
          steps.push(...results);
          if (results.some((x) => x.status === 'cancelled')) {
            emit(index, step, 'cancelled');
            return { status: 'cancelled', final: '', steps };
          }
          // Someone who failed this round (limit, signed out) sits out the rest instead of failing the whole debate.
          active = active.filter((m) => results.some((x) => x.provider === m.provider && x.status === 'ok'));
          if (active.length === 0) {
            const error = `Ninguém conseguiu responder: ${results.map((x) => `${x.provider}: ${x.error}`).join('; ')}`;
            emit(index, step, 'error', { error });
            return { status: 'error', final: '', steps, error };
          }
        }
        const names = active.map((m) => m.provider);
        const judge = names.includes(step.provider) ? step.provider : names[0]!;
        result = await room.turn(
          [judge, ...names.filter((p) => p !== judge)],
          'Close the debate: list what the participants agree on, what they still disagree on, and give your recommended answer for the user.',
          { ...asFor(judge), access: 'read-only' },
        );
        break;
      }
    }

    if (result.status !== 'ok') return fail(index, step, result);
    steps.push(result);
    if (PRODUCES.has(step.kind)) {
      producer = result.provider;
      verdict = undefined; // a review only speaks for the work it looked at
      final = result.text;
    }
    emit(index, step, 'done', step.kind === 'review' && verdict ? { note: verdict === 'approve' ? 'aprovado' : verdict === 'changes' ? 'pede mudanças' : 'sem veredito claro' } : {});
  }

  return { status: 'ok', final, steps, verdict: lastVerdict };
}
