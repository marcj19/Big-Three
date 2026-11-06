export const MOBILE_PORT = 4317;
export const ANDROID_DOWNLOAD = 'https://github.com/marcj19/Big-Three/releases/latest/download/Big-Three-Android.apk';
export type MobileCommand = 'pair' | 'stop';
export interface MobileAccessState {
  enabled: boolean;
  paired: boolean;
  port: number;
  pairing?: { code: string; expiresAt: number };
}
