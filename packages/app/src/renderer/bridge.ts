import { API_METHODS, type Api, type AppEvent } from '../shared/api.js';
import type { MobileAccessState, MobileCommand } from '../shared/mobile.js';

interface Bridge {
  invoke(method: string, args: unknown[]): Promise<unknown>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}

declare global {
  interface Window {
    aioBridge?: Bridge & { writeClipboardText(text: string): Promise<void> };
  }
}

/** In the browser (development) the same calls go to the local dev server, with the token from the page address. */
function webBridge(): Bridge {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
  return {
    async invoke(method, args) {
      const res = await fetch(`/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aio-token': token },
        body: JSON.stringify({ args }),
      });
      const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
      if (!body.ok) throw new Error(body.error ?? 'Request failed');
      return body.result;
    },
    onEvent(callback) {
      const source = new EventSource(`/events?token=${encodeURIComponent(token)}`);
      source.onmessage = (e) => callback(JSON.parse(e.data) as AppEvent);
      return () => source.close();
    },
  };
}

const bridge: Bridge = window.aioBridge ?? webBridge();

export const api = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => bridge.invoke(m, args)])) as unknown as Api;
export const onEvent = (callback: (event: AppEvent) => void): (() => void) => bridge.onEvent(callback);
export const mobileAccess = (command?: MobileCommand): Promise<MobileAccessState> => bridge.invoke('mobileAccess', command ? [command] : []) as Promise<MobileAccessState>;
export const downloadAndroid = (): Promise<void> => bridge.invoke('downloadAndroid', []) as Promise<void>;

export async function writeClipboardText(text: string): Promise<void> {
  if (window.aioBridge) await window.aioBridge.writeClipboardText(text);
  else await navigator.clipboard.writeText(text);
}
