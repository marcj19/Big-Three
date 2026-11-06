import { connect } from 'node:net';
import { localPreviewUrls } from '@aio/core';

async function listening(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, signal });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

export async function findProjectPreview(text: string, signal?: AbortSignal): Promise<string | undefined> {
  for (const candidate of localPreviewUrls(text)) {
    const url = new URL(candidate);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!port) continue;
    const hosts = url.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [url.hostname.replace(/^\[|\]$/g, '')];
    for (const host of hosts) {
      if (signal?.aborted) return undefined;
      if (!(await listening(host, port, signal))) continue;
      if (url.hostname === 'localhost') url.hostname = host === '::1' ? '[::1]' : host;
      return url.href;
    }
  }
}
