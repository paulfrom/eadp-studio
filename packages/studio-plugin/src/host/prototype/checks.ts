import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { PlatformRuntime } from '../adapters/platform/runtime.ts';
import type { PrototypeTaskIdentity } from './generation.ts';
import { prototypeInputHash, sha256, verifyPrototypeContract } from './template.ts';
import type { PrototypeCheckDiagnostic } from '../../shared/prototype.ts';
import { capturePrototypeOutput } from './output.ts';

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

export type PrototypeCommandStep = 'install' | 'typecheck' | 'lint' | 'build';
export type PrototypeCheckStep = PrototypeCommandStep | 'browser' | 'preview';
export type CheckStepObserver = (name: PrototypeCheckStep, status: 'running' | 'passed' | 'failed', exitCode?: number, diagnostic?: PrototypeCheckDiagnostic) => Promise<void>;

async function command(runtime: PlatformRuntime, input: PrototypeTaskIdentity, name: PrototypeCommandStep, args: string[], timeoutMs: number, observer?: CheckStepObserver, signal?: AbortSignal): Promise<number> {
  await observer?.(name, 'running');
  let capture: ReturnType<typeof capturePrototypeOutput> | undefined;
  let status: 'running' | 'passed' | 'failed' = 'running';
  try {
    const process = await runtime.start('pnpm', args, { cwd: input.prototypeRoot, ...(name === 'install' ? { env: { CI: 'true' } } : {}), ...(signal ? { signal } : {}), timeoutMs });
    capture = capturePrototypeOutput(process, async diagnostic => { await observer?.(name, status, undefined, diagnostic); });
    const result = await process.done;
    capture.replace(result.stdout, result.stderr);
    status = result.exitCode === 0 ? 'passed' : 'failed';
    await capture.flush();
    await observer?.(name, status, result.exitCode, capture.snapshot());
    if (result.exitCode !== 0) throw new Error(`工程检查 ${name} 失败（退出码 ${result.exitCode}）`);
    return result.exitCode;
  } catch (error) {
    status = 'failed';
    capture?.fail(error);
    await capture?.flush();
    const diagnostic = capture?.snapshot() ?? { stdout: '', stderr: '', truncated: false, error: error instanceof Error ? error.message : '工程检查中断' };
    await observer?.(name, 'failed', undefined, diagnostic);
    throw error;
  } finally { capture?.dispose(); }
}

export async function installPrototypeDependencies(runtime: PlatformRuntime, input: PrototypeTaskIdentity, signal?: AbortSignal, observer?: CheckStepObserver): Promise<void> {
  await verifyPrototypeContract(input.prototypeRoot, input.manifestPath);
  // Keep resolved package resources inside the same boundary as the source, even after a cached install.
  await command(runtime, input, 'install', ['install', '--frozen-lockfile', '--virtual-store-dir=node_modules/.pnpm'], 600_000, observer, signal);
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
