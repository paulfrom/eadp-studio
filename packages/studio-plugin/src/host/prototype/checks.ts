import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { PlatformRuntime } from '../adapters/platform/runtime.js';
import type { PrototypeTaskIdentity } from './generation.js';
import { prototypeInputHash, sha256, verifyPrototypeContract } from './template.js';

export interface PrototypeCheckResult {
  templateVersion: string;
  sourceSha: string;
  inputHash: string;
  outputHash: string;
  rulesSha256: string;
  projectId: string;
  prototypeTaskId: string;
  sessionId: string;
  startedAt: string;
  completedAt: string;
  commands: { name: 'typecheck' | 'lint' | 'build'; exitCode: number }[];
}

export async function installPrototypeDependencies(runtime: PlatformRuntime, input: PrototypeTaskIdentity, signal?: AbortSignal): Promise<void> {
  await verifyPrototypeContract(input.prototypeRoot, input.manifestPath);
  await runtime.run('pnpm', ['install', '--frozen-lockfile'], {
    cwd: input.prototypeRoot, ...(signal ? { signal } : {}), timeoutMs: 600_000,
  });
}

/** No arbitrary shell strings or task-provided script names enter this boundary. */
export async function runPrototypeChecks(runtime: PlatformRuntime, input: PrototypeTaskIdentity, signal?: AbortSignal): Promise<PrototypeCheckResult> {
  const manifest = await verifyPrototypeContract(input.prototypeRoot, input.manifestPath);
  const rulesSha256 = sha256(await readFile(resolve(input.prototypeRoot, 'AGENT.md')));
  const inputHash = await prototypeInputHash(input.prototypeRoot);
  const startedAt = new Date().toISOString();
  const commands: PrototypeCheckResult['commands'] = [];
  for (const name of ['typecheck', 'lint', 'build'] as const) {
    const result = await runtime.run('pnpm', ['run', name], {
      cwd: input.prototypeRoot, ...(signal ? { signal } : {}), timeoutMs: 300_000,
    });
    commands.push({ name, exitCode: result.exitCode });
  }
  if (inputHash !== await prototypeInputHash(input.prototypeRoot)) throw new Error('Prototype inputs changed while checks were running');
  const outputHash = await prototypeInputHash(resolve(input.prototypeRoot, 'dist'));
  return { outputHash, templateVersion: manifest.version, sourceSha: input.sourceSha, inputHash, rulesSha256,
    projectId: input.projectId, prototypeTaskId: input.prototypeTaskId, sessionId: input.sessionId,
    startedAt, completedAt: new Date().toISOString(), commands };
}

export async function assertCurrentPrototypeChecks(input: PrototypeTaskIdentity, result: PrototypeCheckResult): Promise<void> {
  const manifest = await verifyPrototypeContract(input.prototypeRoot, input.manifestPath);
  if (result.outputHash !== await prototypeInputHash(resolve(input.prototypeRoot, 'dist')) || result.sourceSha !== input.sourceSha || result.inputHash !== await prototypeInputHash(input.prototypeRoot) ||
      result.rulesSha256 !== sha256(await readFile(resolve(input.prototypeRoot, 'AGENT.md'))) || result.templateVersion !== manifest.version ||
      result.projectId !== input.projectId || result.prototypeTaskId !== input.prototypeTaskId || result.sessionId !== input.sessionId ||
      result.commands.length !== 3 || ['typecheck', 'lint', 'build'].some((name) => !result.commands.some((command) => command.name === name && command.exitCode === 0))) {
    throw new Error('Prototype check evidence does not match the current task and input bytes');
  }
}
