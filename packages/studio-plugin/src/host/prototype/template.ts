import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface TemplateFile { path: string; sha256: string }
export interface TemplateManifest {
  schemaVersion: 1;
  version: string;
  files: TemplateFile[];
  addedFiles: TemplateFile[];
  contract: {
    node: string;
    packageManager: string;
    outputDirectory: 'dist';
    previewReadyPath: '/__eadp_preview_ready';
    protectedPaths: string[];
    writablePrefixes: string[];
  };
}

export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const ignoredDirectories = new Set(['node_modules', 'dist', '.git', '.umi', '.umi-production']);
const forbidden = /(^|\/)(?:\.env(?:\..*)?|\.npmrc\.local|\.DS_Store)$|\.(?:pem|key|pfx|p12|log)$/i;

export function resolveTemplatePath(root: string, path: string): string {
  if (!path || path.includes('\\') || isAbsolute(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid prototype path: ${path}`);
  }
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Prototype path escaped root');
  return target;
}

export async function readTemplateManifest(path: string): Promise<TemplateManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as TemplateManifest;
  if (value.schemaVersion !== 1 || !value.version || !Array.isArray(value.files) || !Array.isArray(value.addedFiles) ||
      value.contract?.outputDirectory !== 'dist' || value.contract?.packageManager !== 'pnpm@11.28.5' ||
      value.contract.node !== '22.22.3' || !Array.isArray(value.contract.protectedPaths) ||
      !Array.isArray(value.contract.writablePrefixes)) throw new Error('Unsupported prototype template manifest');
  return value;
}

async function regularPath(root: string, path: string): Promise<string> {
  const target = resolveTemplatePath(root, path);
  let current = target;
  while (current !== root) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic link is forbidden: ${path}`);
    current = dirname(current);
  }
  if (!(await lstat(target)).isFile()) throw new Error(`Expected regular template file: ${path}`);
  return target;
}

export async function listPrototypeFiles(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link is forbidden: ${path}`);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) result.push(...await listPrototypeFiles(root, path));
    } else if (entry.isFile()) {
      if (forbidden.test(path) && !path.endsWith('.env.example')) throw new Error(`Sensitive or generated prototype file: ${path}`);
      result.push(path);
    }
  }
  return result.sort();
}

export async function verifyTemplate(templateRoot: string, manifestPath: string): Promise<TemplateManifest> {
  const root = await realpath(templateRoot);
  const manifest = await readTemplateManifest(manifestPath);
  const entries = [...manifest.files, ...manifest.addedFiles];
  const expected = new Set<string>();
  for (const entry of entries) {
    if (expected.has(entry.path) || !/^[a-f\d]{64}$/.test(entry.sha256)) throw new Error(`Invalid manifest entry: ${entry.path}`);
    expected.add(entry.path);
    if (sha256(await readFile(await regularPath(root, entry.path))) !== entry.sha256) throw new Error(`Template hash mismatch: ${entry.path}`);
  }
  const actual = await listPrototypeFiles(root);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) throw new Error('Template file list differs from bundled manifest');
  return manifest;
}

/** Resumes only matching bundled bytes in an operation-owned directory; never overwrites files. */
export async function copyTemplate(input: { templateRoot: string; manifestPath: string; destinationRoot: string }): Promise<TemplateManifest> {
  const manifest = await verifyTemplate(input.templateRoot, input.manifestPath);
  await mkdir(input.destinationRoot, { recursive: true });
  if ((await lstat(input.destinationRoot)).isSymbolicLink()) throw new Error('Prototype template destination cannot be a symbolic link');
  for (const entry of [...manifest.files, ...manifest.addedFiles]) {
    const source = await regularPath(await realpath(input.templateRoot), entry.path);
    const destination = resolveTemplatePath(input.destinationRoot, entry.path);
    let parent = input.destinationRoot;
    for (const part of entry.path.split('/').slice(0, -1)) {
      parent = resolve(parent, part);
      await mkdir(parent).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Template directory is not regular: ${entry.path}`);
    }
    // regularPath rejects intermediate symlinks before reusing any partial copy.
    try {
      if (sha256(await readFile(await regularPath(await realpath(input.destinationRoot), entry.path))) !== entry.sha256) throw new Error(`Existing template file differs: ${entry.path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    }
    if (sha256(await readFile(destination)) !== entry.sha256) throw new Error(`Copied template hash mismatch: ${entry.path}`);
  }
  await verifyTemplate(input.destinationRoot, input.manifestPath);
  return manifest;
}

/** Generation may change business files; template-owned execution and security files stay pinned. */
export async function verifyPrototypeContract(prototypeRoot: string, manifestPath: string): Promise<TemplateManifest> {
  const root = await realpath(prototypeRoot);
  const manifest = await readTemplateManifest(manifestPath);
  const entries = new Map([...manifest.files, ...manifest.addedFiles].map((entry) => [entry.path, entry]));
  for (const path of manifest.contract.protectedPaths) {
    const entry = entries.get(path);
    if (!entry || sha256(await readFile(await regularPath(root, path))) !== entry.sha256) {
      throw new Error(`Protected template file changed: ${path}`);
    }
  }
  await listPrototypeFiles(root);
  return manifest;
}

export async function prototypeInputHash(prototypeRoot: string): Promise<string> {
  prototypeRoot = await realpath(prototypeRoot);
  const files = await listPrototypeFiles(prototypeRoot);
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(path).update('\0').update(await readFile(await regularPath(prototypeRoot, path))).update('\0');
  }
  return hash.digest('hex');
}
