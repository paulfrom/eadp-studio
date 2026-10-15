import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ManagedProcess, PlatformRuntime } from '../adapters/platform/runtime.js';
import type { PrototypeCheckResult } from './checks.js';
import { assertCurrentPrototypeChecks } from './checks.js';
import type { PrototypeRuleBinding, PrototypeTaskIdentity } from './generation.js';

export interface PrototypePreview {
  url: string;
  sourceSha: string;
  inputHash: string;
  process: ManagedProcess;
  stop(): Promise<void>;
}

export async function startPrototypePreview(runtime: PlatformRuntime, input: PrototypeTaskIdentity, binding: PrototypeRuleBinding,
  checks: PrototypeCheckResult, port: number, signal?: AbortSignal): Promise<PrototypePreview> {
  await assertCurrentPrototypeChecks(input, binding, checks);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback preview port');
  const instance = randomUUID();
  const process = await runtime.start('pnpm', ['run', 'preview', '--', '--port', String(port), '--instance', instance], {
    cwd: input.prototypeRoot, ...(signal ? { signal } : {}),
  });
  let exited = false;
  void process.done.then(() => { exited = true; }, () => { exited = true; });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (signal?.aborted) throw new Error('Preview cancelled');
      if (exited) throw new Error('Preview process exited before becoming ready');
      try {
        const response = await fetch(`${url}/__eadp_preview_ready`, { signal: AbortSignal.timeout(500), redirect: 'error' });
        if (response.ok) {
          const ready = await response.json() as { ready?: boolean; mode?: string; outputDirectory?: string; instance?: string };
          if (ready.ready && ready.mode === 'synthetic-only' && ready.outputDirectory === 'dist' && ready.instance === instance) {
            return { url, sourceSha: input.sourceSha, inputHash: checks.inputHash, process, stop: () => process.stop() };
          }
        }
      } catch { /* A starting loopback listener may refuse connections. */ }
      await delay(100, undefined, signal ? { signal } : undefined);
    }
    throw new Error('Loopback preview readiness timed out');
  } catch (error) { await process.stop(); throw error; }
}
