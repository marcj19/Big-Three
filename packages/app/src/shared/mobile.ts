export const MOBILE_RELAY = 'https://bigthree.pmxtecnologia.com/api/companion/v1';
export const ANDROID_DOWNLOAD = 'https://github.com/marcj19/Big-Three/releases/latest/download/Big-Three-Android.apk';
export type MobileCommand = 'pair' | 'stop';
export interface MobileAccessState {
  enabled: boolean;
  paired: boolean;
  error?: string;
  pairing?: { code: string; expiresAt: number };
}
