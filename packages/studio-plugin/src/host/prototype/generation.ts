import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256, verifyPrototypeContract } from './template.js';

export interface PrototypeTaskIdentity {
  prototypeRoot: string;
  manifestPath: string;
  assetId: string;
  requirementId: string;
  sessionId: string;
  sourceSha: string;
}

export interface PrototypeRuleBinding {
  assetId: string;
  requirementId: string;
  sessionId: string;
  sourceSha: string;
  prototypeRoot: string;
  templateVersion: string;
  rulesSha256: string;
  loadedAt: string;
  entrypoint: string;
}

/** Implemented only by the verified DSH adapter; existence of AGENT.md is not a receipt. */
export interface PrototypeRuleLoader {
  load(input: { sessionId: string; path: string; content: string; sha256: string }): Promise<{
    loaded: boolean;
    sessionId: string;
    sha256: string;
    entrypoint: string;
  }>;
}

export async function loadPrototypeRules(input: PrototypeTaskIdentity, loader: PrototypeRuleLoader): Promise<PrototypeRuleBinding> {
  if (![input.assetId, input.requirementId, input.sessionId].every((value) => value.trim()) || !/^[a-f\d]{40}$/.test(input.sourceSha)) {
    throw new Error('Rules require a fixed source commit, asset, requirement and official session');
  }
  const prototypeRoot = await realpath(input.prototypeRoot);
  const manifest = await verifyPrototypeContract(prototypeRoot, input.manifestPath);
  const path = resolve(prototypeRoot, 'AGENT.md');
  const content = await readFile(path, 'utf8');
  const rulesSha256 = sha256(content);
  const receipt = await loader.load({ sessionId: input.sessionId, path, content, sha256: rulesSha256 });
  if (!receipt.loaded || receipt.sessionId !== input.sessionId || receipt.sha256 !== rulesSha256 || !receipt.entrypoint) {
    throw new Error('DSH did not acknowledge the exact template rules; generation is blocked');
  }
  return { assetId: input.assetId, requirementId: input.requirementId, sessionId: input.sessionId,
    sourceSha: input.sourceSha, prototypeRoot, templateVersion: manifest.version, rulesSha256,
    entrypoint: receipt.entrypoint, loadedAt: new Date().toISOString() };
}

export async function assertRuleBinding(input: PrototypeTaskIdentity, binding: PrototypeRuleBinding): Promise<void> {
  const manifest = await verifyPrototypeContract(input.prototypeRoot, input.manifestPath);
  if (binding.prototypeRoot !== await realpath(input.prototypeRoot) || binding.templateVersion !== manifest.version ||
      binding.assetId !== input.assetId || binding.requirementId !== input.requirementId || binding.sessionId !== input.sessionId ||
      binding.sourceSha !== input.sourceSha || !binding.entrypoint ||
      binding.rulesSha256 !== sha256(await readFile(resolve(input.prototypeRoot, 'AGENT.md')))) {
    throw new Error('Template rule binding is stale or belongs to a different task');
  }
}

export async function assertWritablePrototypePaths(input: PrototypeTaskIdentity, binding: PrototypeRuleBinding, paths: readonly string[]): Promise<void> {
  await assertRuleBinding(input, binding);
  const manifest = await verifyPrototypeContract(input.prototypeRoot, input.manifestPath);
  for (const path of paths) {
    if (path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..') ||
        manifest.contract.protectedPaths.includes(path) ||
        !manifest.contract.writablePrefixes.some((prefix) => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix)) {
      throw new Error(`Path is outside the authorized prototype generation area: ${path}`);
    }
  }
}
