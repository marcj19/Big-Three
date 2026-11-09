import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { MOBILE_RELAY, type MobileAccessState, type MobileCommand } from '../shared/mobile.js';
import type { AppService } from './app-service.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const token = z.string().regex(TOKEN);
const exchangeId = z.string().uuid();
const readRequest = z.object({ conversationId: z.string().uuid().optional(), etag: token.optional() }).strict();
const promptRequest = z.object({ op: z.literal('prompt'), permit: token, conversationId: z.string().uuid(),
  provider: z.enum(['claude', 'gemini', 'codex']), prompt: z.string().trim().min(1).max(2000) }).strict();
const request = z.union([readRequest, promptRequest]);
const storedSession = z.object({ id: token, writer: token, key: token, allowPrompts: z.boolean().optional() });
export type CompanionSession = z.infer<typeof storedSession>;
type PromptReply = Awaited<ReturnType<AppService['mobileStartPrompt']>>;
type Reply = { status: number; etag?: string; data?: unknown; message?: string };
const nextResponse = z.object({ paired: z.boolean(), request: z.object({ id: exchangeId, payload: z.string().max(4096) }).optional() });

const secret = () => randomBytes(32).toString('base64url');
export const mobileHash = (value: string) => createHash('sha256').update(value).digest('base64url');
export function derivePairing(code: string) {
  const derive = (label: string) => createHmac('sha256', Buffer.from(code, 'base64url')).update(`big-three/v1/${label}`).digest('base64url');
  return { id: derive('id'), claim: derive('claim'), key: derive('key') };
}

export function seal(key: string, exchange: string, direction: 'read' | 'reply', json: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), nonce);
  cipher.setAAD(Buffer.from(`big-three/v1/${direction}/${exchange}`));
  return Buffer.concat([nonce, cipher.update(json), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}

export function open(key: string, exchange: string, direction: 'read' | 'reply', payload: string): unknown {
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.length < 28) throw new Error('Invalid encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(`big-three/v1/${direction}/${exchange}`));
  decipher.setAuthTag(bytes.subarray(-16));
  const json = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  return JSON.parse(json);
}

interface MobileOptions {
  load?: () => Promise<unknown>;
  save?: (session: CompanionSession | undefined) => Promise<void>;
  relayUrl?: string;
}

class RelayError extends Error {
  constructor(readonly status: number) { super('Não foi possível se conectar ao servidor do Big Three.'); }
}

/** The PC only makes outbound requests. The relay never receives the pairing code or the encryption key. */
export class MobileGateway {
  private session?: CompanionSession;
  private pairing?: { code: string; expiresAt: number };
  private paired = false;
  private error?: string;
  private poll?: AbortController;
  private promptPermit?: string;
  private lastPrompt?: { id: string; permit: string; response: PromptReply };
  private commands = Promise.resolve();
  private readonly relay: string;

  constructor(private readonly app: Pick<AppService, 'mobileConversations' | 'mobileConversation' | 'mobileStartPrompt'>, private readonly options: MobileOptions = {}) {
    this.relay = options.relayUrl ?? MOBILE_RELAY;
  }

  state(): MobileAccessState {
    const pairing = this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing : undefined;
    return { enabled: !!this.session, paired: this.paired, allowPrompts: !!this.promptPermit, error: this.error, pairing };
  }

  async restore(): Promise<void> {
    const stored = storedSession.safeParse(await this.options.load?.());
    if (stored.success && !this.session) this.start(stored.data);
  }

  manage(command?: MobileCommand): Promise<MobileAccessState> {
    if (!command) return Promise.resolve(this.state());
    const result = this.commands.then(async () => {
      if (command === 'pair') await this.register();
      else if (command === 'stop') {
        const previous = this.session;
        await this.options.save?.(undefined);
        this.shutdown();
        this.session = undefined;
        this.pairing = undefined;
        this.paired = false;
        this.error = undefined;
        this.setPromptPermit(false);
        if (previous) await this.revoke(previous);
      } else if (this.session && this.paired) {
        const allowPrompts = command === 'allow-prompts';
        const next = { ...this.session, allowPrompts };
        await this.options.save?.(next);
        this.session = next;
        this.setPromptPermit(allowPrompts);
      }
      return this.state();
    });
    this.commands = result.then(() => {}, () => {});
    return result;
  }

  shutdown(): void { this.poll?.abort(); this.poll = undefined; }

  private setPromptPermit(enabled: boolean): void {
    this.promptPermit = enabled ? secret() : undefined;
    this.lastPrompt = undefined;
  }

  private async register(): Promise<void> {
    const code = secret();
    const { id, claim, key } = derivePairing(code);
    const next = { id, key, writer: secret() };
    const previous = this.session;
    const data = await this.call('/sessions', next.writer, 'POST', { id, verifier: mobileHash(claim) });
    try {
      const { expiresAt } = z.object({ expiresAt: z.number().int().positive() }).parse(data);
      await this.options.save?.(next);
      this.pairing = { code, expiresAt };
      this.start(next);
    } catch (error) {
      await this.revoke(next);
      throw error;
    }
    if (previous) void this.revoke(previous);
  }

  private async revoke({ id, writer }: CompanionSession): Promise<void> {
    // If the relay is unreachable, shutting down the desktop poll still cuts off access to data.
    await this.call(`/sessions/${id}`, writer, 'DELETE', undefined, AbortSignal.timeout(3000)).catch(() => {});
  }

  private start(session: CompanionSession): void {
    this.shutdown();
    this.session = session;
    this.paired = false;
    this.error = undefined;
    this.setPromptPermit(!!session.allowPrompts);
    const controller = new AbortController();
    this.poll = controller;
    void this.run(session, controller.signal);
  }

  private async run(session: CompanionSession, signal: AbortSignal): Promise<void> {
    const root = `/sessions/${session.id}`;
    while (!signal.aborted) {
      try {
        const next = nextResponse.parse(await this.call(`${root}/next`, session.writer, 'GET', undefined, signal));
        if (signal.aborted) return;
        this.paired = next.paired;
        this.error = undefined;
        if (next.paired) this.pairing = undefined;
        if (next.request) await this.reply(session, next.request, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof RelayError && error.status === 401) {
          this.paired = false;
          this.pairing = undefined;
          this.setPromptPermit(false);
          this.error = 'O pareamento expirou. Gere um novo token.';
          return;
        }
        this.error = 'Servidor do Big Three indisponível. Tentando reconectar…';
        await delay(3000, undefined, { signal }).catch(() => {});
      }
    }
  }

  private async reply(session: CompanionSession, item: { id: string; payload: string }, signal: AbortSignal): Promise<void> {
    let response: Reply = { status: 400 };
    try {
      const input = request.parse(open(session.key, item.id, 'read', item.payload));
      if ('op' in input) response = await this.submit(input, item.id, signal);
      else {
        const detail = input.conversationId ? await this.app.mobileConversation(input.conversationId) : undefined;
        const data = input.conversationId ? detail && { ...detail, promptPermit: this.promptPermit } : await this.app.mobileConversations();
        const etag = data === undefined ? undefined : mobileHash(JSON.stringify(data));
        response = data === undefined ? { status: 404 } : etag === input.etag ? { status: 304, etag } : { status: 200, etag, data };
      }
    } catch { /* A corrupted request receives no conversation data. */ }
    const payload = seal(session.key, item.id, 'reply', JSON.stringify(response));
    await this.call(`/sessions/${session.id}/reply`, session.writer, 'POST', { exchange: item.id, payload }, signal).catch((error) => {
      if (!(error instanceof RelayError) || error.status !== 404) throw error;
    });
  }

  private async submit(input: z.infer<typeof promptRequest>, id: string, signal: AbortSignal): Promise<Reply> {
    if (!this.promptPermit || signal.aborted) return { status: 403, message: 'Ative o envio de prompts no Big Three do PC.' };
    if (this.lastPrompt?.id === id && this.lastPrompt.permit === input.permit) return this.lastPrompt.response;
    if (input.permit !== this.promptPermit) return { status: 409, message: 'Atualize a conversa antes de enviar de novo.' };
    // Consume before starting a run. Each restart or permission change invalidates old requests.
    const nextPermit = secret();
    this.promptPermit = nextPermit;
    const authorized = () => !signal.aborted && this.promptPermit === nextPermit;
    const response = await this.app.mobileStartPrompt(input, authorized);
    if (authorized()) this.lastPrompt = { id, permit: input.permit, response };
    return response;
  }

  private async call(path: string, credential: string, method: string, body?: object, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(17_000);
    try {
      const response = await fetch(this.relay + path, {
        method, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { authorization: `Bearer ${credential}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new RelayError(response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError(503);
    }
  }
}
