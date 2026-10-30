import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ManagedProcess, PlatformRuntime } from '../adapters/platform/runtime.ts';
import type { CheckStepObserver, PrototypeCheckResult } from './checks.ts';
import { assertCurrentPrototypeBuild } from './checks.ts';
import type { PrototypeTaskIdentity } from './generation.ts';
import { capturePrototypeOutput } from './output.ts';

export interface PrototypePreview {
  previewId: string;
  buildHash: string;
  url: string;
  sourceSha: string;
  inputHash: string;
  process: ManagedProcess;
  stop(): Promise<void>;
}

export async function startPrototypePreview(runtime: PlatformRuntime, input: PrototypeTaskIdentity,
  checks: PrototypeCheckResult, port: number, signal?: AbortSignal, observer?: CheckStepObserver): Promise<PrototypePreview> {
  await assertCurrentPrototypeBuild(input, checks);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback preview port');
  await observer?.('preview', 'running');
  const instance = randomUUID();
  const process = await runtime.start('pnpm', ['run', 'preview', '--', '--port', String(port), '--instance', instance], {
    cwd: input.prototypeRoot, ...(signal ? { signal } : {}),
  });
  let ready = false;
  const capture = capturePrototypeOutput(process, async diagnostic => { await observer?.('preview', ready ? 'passed' : 'running', undefined, diagnostic); });
  let exited = false;
  void process.done.then(() => { exited = true; }, () => { exited = true; });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (signal?.aborted) throw new Error('Preview cancelled');
      if (exited) throw new Error('Preview process exited before becoming ready');
      let status: { ready?: boolean; mode?: string; outputDirectory?: string; instance?: string } | undefined;
      try {
        const response = await fetch(`${url}/__eadp_preview_ready`, { signal: AbortSignal.timeout(500), redirect: 'error' });
        if (response.ok) status = await response.json() as NonNullable<typeof status>;
      } catch { /* A starting loopback listener may refuse connections. */ }
      if (status?.ready && status.mode === 'synthetic-only' && status.outputDirectory === 'dist' && status.instance === instance) {
        ready = true;
        await capture.flush();
        await observer?.('preview', 'passed', undefined, capture.snapshot());
        return { previewId: instance, buildHash: checks.outputHash, url, sourceSha: input.sourceSha, inputHash: checks.inputHash, process, stop: async () => { capture.dispose(); await process.stop(); } };
      }
      await delay(100, undefined, signal ? { signal } : undefined);
    }
    throw new Error('Loopback preview readiness timed out');
  } catch (error) {
    capture.fail(error);
    try { await capture.flush(); await observer?.('preview', 'failed', undefined, capture.snapshot()); } catch { /* Preserve the startup failure and clean up the process. */ }
    capture.dispose();
    await process.stop();
    throw error;
  }
}
