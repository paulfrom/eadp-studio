import { handlers, resetMockData } from './handlers';

let ready = false;

export async function initializeMock(): Promise<void> {
  if (window.__EADP_MOCK_GUARD__?.version !== 'synthetic-only-v1') {
    throw new Error('网络保护未就绪，已阻断演示');
  }
  if (ready) return;
  resetMockData();
  ready = true;
  Object.defineProperty(window, '__EADP_MOCK__', {
    writable: false,
    configurable: false,
    value: Object.freeze({
      get ready() { return ready; },
      version: 'synthetic-only-v1',
      async verify(): Promise<{ unknownRejected: boolean; ready: boolean }> {
        let unknownRejected = false;
        try { await requestMock('GET', '/__eadp_unknown_probe__'); }
        catch (error) { unknownRejected = error instanceof Error && error.message.startsWith('未知 Mock 请求已拒绝：'); }
        return { unknownRejected, ready };
      },
    }),
  });
}

/** Local service dispatch: never uses fetch, a server, localStorage or real credentials. */
export async function requestMock<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!ready || !window.__EADP_MOCK_GUARD__?.installed) throw new Error('Mock 尚未就绪');
  const key = `${method.toUpperCase()} ${path}`;
  if (!Object.hasOwn(handlers, key)) throw new Error(`未知 Mock 请求已拒绝：${key}`);
  await new Promise<void>((resolve) => { window.setTimeout(resolve, 250); });
  return structuredClone(handlers[key](body)) as T;
}
