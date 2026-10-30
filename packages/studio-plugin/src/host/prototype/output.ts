import type { ManagedProcess } from '../adapters/platform/runtime.ts';
import type { PrototypeCheckDiagnostic } from '../../shared/prototype.ts';

export interface PrototypeOutputCapture {
  replace(stdout: string, stderr: string): void;
  fail(error: unknown): void;
  snapshot(): PrototypeCheckDiagnostic;
  flush(): Promise<void>;
  dispose(): void;
}

/** Bounds and persists live process output without allowing observer writes to overlap. */
export function capturePrototypeOutput(process: ManagedProcess, observer?: (diagnostic: PrototypeCheckDiagnostic) => Promise<void>): PrototypeOutputCapture {
  const diagnostic: PrototypeCheckDiagnostic = { stdout: '', stderr: '', truncated: false };
  let timer: NodeJS.Timeout | undefined;
  let pending = Promise.resolve();
  let disposed = false;
  const snapshot = () => ({ ...diagnostic });
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!observer || disposed) return;
    const value = snapshot();
    pending = pending.catch(() => {}).then(() => observer(value));
    await pending;
  };
  const schedule = () => {
    if (!observer || timer || disposed) return;
    timer = setTimeout(() => { timer = undefined; void flush().catch(() => {}); }, 200);
    timer.unref();
  };
  const append = (channel: 'stdout' | 'stderr', text: string) => {
    const remaining = 65536 - diagnostic[channel].length;
    diagnostic[channel] += text.slice(0, remaining);
    if (text.length > remaining) diagnostic.truncated = true;
    schedule();
  };
  const unsubscribe = process.onOutput(append);
  return {
    replace(stdout, stderr) {
      diagnostic.stdout = ''; diagnostic.stderr = ''; diagnostic.truncated = false;
      diagnostic.stdout = stdout.slice(0, 65536);
      diagnostic.stderr = stderr.slice(0, 65536);
      diagnostic.truncated = stdout.length > 65536 || stderr.length > 65536;
    },
    fail(error) { diagnostic.error = error instanceof Error ? error.message : '工程检查中断'; },
    snapshot,
    flush,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      unsubscribe();
    },
  };
}
