import type { Access, McpServerSpec, Permissions, ProviderId } from '@aio/core';
import { NAMES } from './prompt.js';
import type { Room } from './room.js';
import type { TurnOptions, TurnResult } from './types.js';

export type Verdict = 'approve' | 'changes' | 'unclear';

export interface PatternResult {
  status: 'ok' | 'error' | 'cancelled';
  /** The answer to hand back to the user. */
  final: string;
  /** Every turn that ran, in order. */
  steps: TurnResult[];
  verdict?: Verdict;
  error?: string;
}

export interface PatternOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Give models the room tools where their CLI supports MCP injection. */
  withPeerTools?: boolean;
  /** Extra MCP servers (e.g. the database broker) for models that can take them. */
  mcpServers?: McpServerSpec[];
  /** What every model in the run may reach beyond the folder (web, browser). Defaults to nothing. */
  permissions?: Permissions;
}

type Who = ProviderId | ProviderId[];
const list = (who: Who): ProviderId[] => (Array.isArray(who) ? who : [who]);

/** The last verdict line wins, so a reviewer quoting "VERDICT: APPROVE" earlier in its text cannot flip it. */
export function parseVerdict(text: string): Verdict {
  const all = [...text.matchAll(/^\W*VERDICT\s*:\s*(APPROVE|CHANGES)\b/gim)];
  const last = all[all.length - 1]?.[1]?.toUpperCase();
  return last === 'APPROVE' ? 'approve' : last === 'CHANGES' ? 'changes' : 'unclear';
}

const VERDICT_LINE = 'Finish with exactly one line: `VERDICT: APPROVE` if it can be used as it is, otherwise `VERDICT: CHANGES`.';

class Run {
  readonly steps: TurnResult[] = [];
  constructor(private readonly room: Room, private readonly opts: PatternOptions) {}

  turnOptions(access: Access = 'read-only'): TurnOptions {
    return { access, cwd: this.opts.cwd, signal: this.opts.signal, timeoutMs: this.opts.timeoutMs, withPeerTools: this.opts.withPeerTools, mcpServers: this.opts.mcpServers, permissions: this.opts.permissions };
  }

  async turn(who: Who, instruction: string, access?: Access): Promise<TurnResult> {
    const result = await this.room.turn(who, instruction, this.turnOptions(access));
    this.steps.push(result);
    return result;
  }

  stopped(result: TurnResult | undefined): PatternResult | undefined {
    if (result?.status === 'cancelled') return { status: 'cancelled', final: '', steps: this.steps };
    if (result?.status === 'error') return { status: 'error', final: '', steps: this.steps, error: result.error };
    return undefined;
  }

  ok(final: string, verdict?: Verdict): PatternResult {
    return { status: 'ok', final, steps: this.steps, verdict };
  }

  fail(error: string): PatternResult {
    return { status: 'error', final: '', steps: this.steps, error };
  }
}

export interface CrossReviewInput extends PatternOptions {
  task: string;
  author: Who;
  reviewer: Who;
  /** How many times the author may rewrite after a review asking for changes. Default 1. */
  maxRevisions?: number;
}

/** One model answers, another one reviews it critically, the author fixes what was found. */
export async function crossReview(room: Room, input: CrossReviewInput): Promise<PatternResult> {
  const run = new Run(room, input);
  await room.say(input.task);

  let draft = await run.turn(input.author, 'Answer the user\'s request (the first message in the transcript).');
  const early = run.stopped(draft);
  if (early) return early;

  let verdict: Verdict = 'unclear';
  for (let revision = 0; revision <= (input.maxRevisions ?? 1); revision++) {
    // A model grading its own work is not a review; if the only reviewer left is the author, say so.
    const reviewers = list(input.reviewer).filter((p) => p !== draft.provider);
    if (reviewers.length === 0) return run.fail(`No reviewer other than ${NAMES[draft.provider]} is available`);

    const review = await run.turn(
      reviewers,
      `Review ${NAMES[draft.provider]}'s latest answer critically. Check its claims against the actual code or files when it refers to them. ` +
        `List concrete problems, most important first, each with why it matters and how to fix it, and say what is already right. ${VERDICT_LINE}`,
    );
    const stopped = run.stopped(review);
    if (stopped) return stopped;
    verdict = parseVerdict(review.text);
    if (verdict === 'approve' || revision === (input.maxRevisions ?? 1)) break;

    draft = await run.turn(
      draft.provider,
      `${NAMES[review.provider]} reviewed your answer. Rewrite it fixing every valid point and say briefly which points you rejected and why. Give the complete corrected answer.`,
    );
    const failed = run.stopped(draft);
    if (failed) return failed;
  }
  return run.ok(draft.text, verdict);
}

export interface PlanExecuteInput extends PatternOptions {
  task: string;
  planner: Who;
  executor: Who;
  /** Required on purpose: whether the executor may change files is the caller's decision, never a default. */
  executorAccess: Access;
  reviewer?: Who;
}

/** One model plans without touching anything, another carries it out, a third optionally checks the result. */
export async function planExecute(room: Room, input: PlanExecuteInput): Promise<PatternResult> {
  const run = new Run(room, input);
  await room.say(input.task);

  const plan = await run.turn(
    input.planner,
    'Write a short numbered plan for the user\'s request: the steps, the files involved and the risks. Do not change anything and do not carry the plan out.',
  );
  const noPlan = run.stopped(plan);
  if (noPlan) return noPlan;

  const done = await run.turn(
    input.executor,
    `Carry out ${NAMES[plan.provider]}'s plan. Follow it unless it is wrong, and say so if you deviate. Report what you changed and anything you could not do.`,
    input.executorAccess,
  );
  const notDone = run.stopped(done);
  if (notDone) return notDone;
  if (!input.reviewer) return run.ok(done.text);

  const reviewers = list(input.reviewer).filter((p) => p !== done.provider);
  if (reviewers.length === 0) return run.fail(`No reviewer other than ${NAMES[done.provider]} is available`);
  const check = await run.turn(
    reviewers,
    `Check what ${NAMES[done.provider]} did against the plan by reading the actual files, not just its report. List anything missing, wrong or risky. ${VERDICT_LINE}`,
  );
  const unchecked = run.stopped(check);
  if (unchecked) return unchecked;
  return run.ok(`${done.text}\n\n--- Review by ${NAMES[check.provider]} ---\n${check.text}`, parseVerdict(check.text));
}

export interface DebateInput extends PatternOptions {
  question: string;
  participants: ProviderId[];
  /** Rounds of answering, the first one independent. Default 2. */
  rounds?: number;
  /** Who writes the closing synthesis; defaults to the first participant that is still answering. */
  judge?: ProviderId;
}

/** Everyone answers on their own, then each reads the others and refines; one of them closes with a synthesis. */
export async function debate(room: Room, input: DebateInput): Promise<PatternResult> {
  const run = new Run(room, input);
  if (new Set(input.participants).size < 2) return run.fail('A debate needs at least two different participants');
  await room.say(input.question);

  let active = [...new Set(input.participants)];
  const rounds = Math.max(1, input.rounds ?? 2);
  for (let r = 1; r <= rounds; r++) {
    const instruction =
      r === 1
        ? 'Answer the user\'s question on your own. Be concrete and say how sure you are.'
        : 'Read the other participants\' latest answers. Say where you agree, where you disagree and why, concede what they got right, and give your updated answer.';
    const results = await room.round(active.map((provider) => ({ provider, instruction, options: run.turnOptions() })));
    run.steps.push(...results);
    if (results.some((x) => x.status === 'cancelled')) return { status: 'cancelled', final: '', steps: run.steps };
    // Someone who failed this round (limit, signed out) sits out the rest instead of failing the whole debate.
    active = results.filter((x) => x.status === 'ok').map((x) => x.provider);
    if (active.length === 0) return run.fail(`Nobody could answer: ${results.map((x) => `${x.provider}: ${x.error}`).join('; ')}`);
  }

  const judge = input.judge && active.includes(input.judge) ? input.judge : active[0]!;
  const verdict = await run.turn(
    [judge, ...active.filter((p) => p !== judge)],
    'Close the debate: list what the participants agree on, what they still disagree on, and give your recommended answer for the user.',
  );
  const stopped = run.stopped(verdict);
  if (stopped) return stopped;
  return run.ok(verdict.text);
}
