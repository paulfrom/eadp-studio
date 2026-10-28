import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { PlatformRuntime } from '../adapters/platform/runtime.js';
import type { PrototypeTaskIdentity } from './generation.js';
import { prototypeInputHash, sha256, verifyPrototypeContract } from './template.js';
import type { PrototypeCheckDiagnostic } from '../../shared/prototype.ts';

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

export type PrototypeCheckStep = 'install' | 'typecheck' | 'lint' | 'build' | 'browser';
export type CheckStepObserver = (name: PrototypeCheckStep, status: 'running' | 'passed' | 'failed', exitCode?: number, diagnostic?: PrototypeCheckDiagnostic) => Promise<void>;

async function command(runtime: PlatformRuntime, input: PrototypeTaskIdentity, name: Exclude<PrototypeCheckStep, 'browser'>, args: string[], timeoutMs: number, observer?: CheckStepObserver, signal?: AbortSignal): Promise<number> {
  await observer?.(name, 'running');
  const diagnostic: PrototypeCheckDiagnostic = { stdout: '', stderr: '', truncated: false };
  const append = (channel: 'stdout' | 'stderr', text: string) => {
    const remaining = 65536 - diagnostic[channel].length;
    diagnostic[channel] += text.slice(0, remaining);
    if (text.length > remaining) diagnostic.truncated = true;
  };
  let unsubscribe: (() => void) | undefined;
  try {
    const process = await runtime.start('pnpm', args, { cwd: input.prototypeRoot, ...(signal ? { signal } : {}), timeoutMs });
    unsubscribe = process.onOutput(append);
    const result = await process.done;
    diagnostic.stdout = ''; diagnostic.stderr = ''; diagnostic.truncated = false;
    append('stdout', result.stdout); append('stderr', result.stderr);
    await observer?.(name, result.exitCode === 0 ? 'passed' : 'failed', result.exitCode, diagnostic);
    if (result.exitCode !== 0) throw new Error(`工程检查 ${name} 失败（退出码 ${result.exitCode}）`);
    return result.exitCode;
  } catch (error) {
    diagnostic.error = error instanceof Error ? error.message : '工程检查中断';
    await observer?.(name, 'failed', undefined, diagnostic);
    throw error;
  } finally { unsubscribe?.(); }
}

export async function installPrototypeDependencies(runtime: PlatformRuntime, input: PrototypeTaskIdentity, signal?: AbortSignal, observer?: CheckStepObserver): Promise<void> {
  await verifyPrototypeContract(input.prototypeRoot, input.manifestPath);
  await command(runtime, input, 'install', ['install', '--frozen-lockfile'], 600_000, observer, signal);
}

/** No arbitrary shell strings or task-provided script names enter this boundary. */
export async function runPrototypeChecks(runtime: PlatformRuntime, input: PrototypeTaskIdentity, signal?: AbortSignal, observer?: CheckStepObserver): Promise<PrototypeCheckResult> {
  return runPrototypeCommands(runtime, input, ['typecheck', 'lint', 'build'], signal, observer);
}

/** Build the preview without making unrelated diagnostics a prerequisite for viewing it. */
export async function buildPrototypePreview(runtime: PlatformRuntime, input: PrototypeTaskIdentity, signal?: AbortSignal, observer?: CheckStepObserver): Promise<PrototypeCheckResult> {
  return runPrototypeCommands(runtime, input, ['build'], signal, observer);
}

async function runPrototypeCommands(runtime: PlatformRuntime, input: PrototypeTaskIdentity, names: Array<'typecheck' | 'lint' | 'build'>, signal?: AbortSignal, observer?: CheckStepObserver): Promise<PrototypeCheckResult> {
  const manifest = await verifyPrototypeContract(input.prototypeRoot, input.manifestPath);
  const rulesSha256 = sha256(await readFile(resolve(input.prototypeRoot, 'AGENT.md')));
  const inputHash = await prototypeInputHash(input.prototypeRoot);
  const startedAt = new Date().toISOString();
  const commands: PrototypeCheckResult['commands'] = [];
  for (const name of names) {
    const exitCode = await command(runtime, input, name, ['run', name], 300_000, observer, signal);
    commands.push({ name, exitCode });
  }
  if (inputHash !== await prototypeInputHash(input.prototypeRoot)) throw new Error('Prototype inputs changed while checks were running');
  const outputHash = await prototypeInputHash(resolve(input.prototypeRoot, 'dist'));
  return { outputHash, templateVersion: manifest.version, sourceSha: input.sourceSha, inputHash, rulesSha256,
    projectId: input.projectId, prototypeTaskId: input.prototypeTaskId, sessionId: input.sessionId,
    startedAt, completedAt: new Date().toISOString(), commands };
}

export async function assertCurrentPrototypeChecks(input: PrototypeTaskIdentity, result: PrototypeCheckResult): Promise<void> {
  await assertCurrentPrototypeBuild(input, result);
  if (result.commands.length !== 3 || ['typecheck', 'lint', 'build'].some((name) => !result.commands.some((command) => command.name === name && command.exitCode === 0))) {
    throw new Error('Prototype checks do not include all successful engineering steps');
  }
}

/** Confirm that the displayed build belongs to the current source and output. */
export async function assertCurrentPrototypeBuild(input: PrototypeTaskIdentity, result: PrototypeCheckResult): Promise<void> {
  const manifest = await verifyPrototypeContract(input.prototypeRoot, input.manifestPath);
  if (result.outputHash !== await prototypeInputHash(resolve(input.prototypeRoot, 'dist')) || result.sourceSha !== input.sourceSha || result.inputHash !== await prototypeInputHash(input.prototypeRoot) ||
      result.rulesSha256 !== sha256(await readFile(resolve(input.prototypeRoot, 'AGENT.md'))) || result.templateVersion !== manifest.version ||
      result.projectId !== input.projectId || result.prototypeTaskId !== input.prototypeTaskId || result.sessionId !== input.sessionId ||
      !result.commands.some(command => command.name === 'build' && command.exitCode === 0)) {
    throw new Error('Prototype build does not match the current task and input bytes');
  }
}
