import { handlers, resetMockData } from './handlers';

let ready = false;

export async function initializeMock(): Promise<void> {
  if (ready) return;
  resetMockData();
  ready = true;
}

/** Local service dispatch: never uses fetch, a server, localStorage or real credentials. */
export async function requestMock<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!ready) throw new Error('Mock 尚未就绪');
  const key = `${method.toUpperCase()} ${path}`;
  if (!Object.hasOwn(handlers, key)) throw new Error(`未知 Mock 请求已拒绝：${key}`);
  await new Promise<void>((resolve) => { window.setTimeout(resolve, 250); });
  return structuredClone(handlers[key](body)) as T;
}
