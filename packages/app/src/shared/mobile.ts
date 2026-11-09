import type { ProviderId, StartRun } from './api.js';

export const MOBILE_RELAY = 'https://bigthree.pmxtecnologia.com/api/companion/v1';
export const ANDROID_DOWNLOAD = 'https://github.com/marcj19/Big-Three/releases/latest/download/Big-Three-Android.apk';
export type MobileCommand = 'pair' | 'stop' | 'allow-prompts' | 'block-prompts';
export interface MobileAccessState {
  enabled: boolean;
  paired: boolean;
  allowPrompts: boolean;
  error?: string;
  pairing?: { code: string; expiresAt: number };
}

export interface MobilePrompt { conversationId: string; provider: ProviderId; prompt: string }
export const mobilePromptRun = ({ conversationId, provider, prompt }: MobilePrompt): StartRun => ({
  conversationId, prompt, spec: { kind: 'lead', lead: { provider }, team: [], fallback: false, access: 'read-only' },
  connections: [], peerTools: false,
});
