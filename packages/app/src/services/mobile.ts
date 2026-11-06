import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { MOBILE_PORT, type MobileAccessState, type MobileCommand } from '../shared/mobile.js';
import type { AppService } from './app-service.js';

const PAIR_TIME = 5 * 60_000;
const id = z.string().uuid();
const secret = () => randomBytes(24).toString('base64url');
const digest = (token: string) => createHash('sha256').update(token).digest();
const matches = (token: string, expected: Buffer | undefined) => !!expected && timingSafeEqual(digest(token), expected);

/** A dedicated loopback API for mobile clients. A private HTTPS transport can forward to this port. */
export class MobileGateway {
  private server?: Server;
  private opening?: Promise<void>;
  private session?: { login: string; credential: Buffer };
  private pairing?: { code: string; expiresAt: number };

  constructor(private readonly app: Pick<AppService, 'mobileConversations' | 'mobileConversation'>, private readonly port = MOBILE_PORT) {}

  state(): MobileAccessState {
    const pairing = this.pairing && this.pairing.expiresAt > Date.now() ? this.pairing : undefined;
    const address = this.server?.address() as AddressInfo | null | undefined;
    return { enabled: !!address, paired: !!this.session, port: address?.port ?? this.port, pairing };
  }

  async manage(command?: MobileCommand): Promise<MobileAccessState> {
    if (this.opening) await this.opening;
    if (command === 'stop') {
      this.stop();
    } else if (command === 'pair') {
      if (!this.server) {
        this.opening = this.listen();
        try { await this.opening; } finally { this.opening = undefined; }
      }
      this.pairing = { code: secret(), expiresAt: Date.now() + PAIR_TIME };
    }
    return this.state();
  }

  stop(): void {
    this.pairing = undefined;
    this.session = undefined;
    const server = this.server;
    this.server = undefined;
    server?.close();
    server?.closeAllConnections();
  }

  private listen(): Promise<void> {
    const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 2_000 }, (req, res) => {
      void this.request(req, res);
    });
    server.maxConnections = 12;
    return new Promise((resolve, reject) => {
      server.once('error', () => reject(new Error(`Não foi possível ativar o acesso pelo celular na porta ${this.port}.`)));
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        resolve();
      });
    });
  }

  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, value: unknown) => {
      const json = JSON.stringify(value);
      const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      if (req.method === 'GET' && status === 200) {
        headers.etag = `"${digest(json).toString('base64url')}"`;
        if (req.headers['if-none-match'] === headers.etag) {
          res.writeHead(304, headers).end();
          return;
        }
      }
      res.writeHead(status, headers).end(json);
    };
    // Serve strips incoming identity headers and only supplies a login for authenticated tailnet traffic.
    const login = req.headers['tailscale-user-login'];
    if (typeof login !== 'string' || !login.trim()) return send(403, { error: 'Conecte pelo Tailscale Serve na rede privada.' });
    // Credentials are only accepted in the header, never in URLs or logs.
    const token = /^Bearer ([\w-]{32})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return send(401, { error: 'Credencial inválida.' });
    if (req.method === 'POST' && req.url === '/v1/pair') {
      const pairing = this.state().pairing;
      if (!pairing || !matches(token, digest(pairing.code))) return send(401, { error: 'Código inválido ou vencido.' });
      const credential = secret();
      this.session = { login, credential: digest(credential) };
      this.pairing = undefined;
      return send(200, { credential });
    }
    if (this.session?.login !== login || !matches(token, this.session.credential)) return send(401, { error: 'Pareamento encerrado. Gere um novo código no PC.' });
    if (req.method !== 'GET') return send(405, { error: 'O celular tem acesso de acompanhamento.' });
    try {
      if (req.url === '/v1/conversations') return send(200, await this.app.mobileConversations());
      const match = /^\/v1\/conversations\/([\da-f-]+)$/.exec(req.url ?? '');
      if (match && id.safeParse(match[1]).success) {
        const detail = await this.app.mobileConversation(match[1]!);
        if (detail) return send(200, detail);
      }
      send(404, { error: 'Conversa ou rota não encontrada.' });
    } catch {
      send(500, { error: 'Não foi possível consultar as informações no PC.' });
    }
  }
}
