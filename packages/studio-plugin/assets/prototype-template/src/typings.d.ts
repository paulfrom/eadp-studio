declare module '*.less';
declare module '*.svg';
declare module '*.png';

interface Window {
  readonly __EADP_MOCK_GUARD__?: { readonly version: string; readonly installed: boolean };
  readonly __EADP_MOCK__?: { readonly ready: boolean; readonly version: string; verify(): Promise<{ unknownRejected: boolean; ready: boolean }> };
}
