import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { canonicalWritePath, withPathWriteLock } from './path-write-lock.js'

interface StudioExecutionAgent { readonly session: { readonly header: { readonly cwd?: string } } }
interface GuardExecution { readonly name: string; readonly arguments: unknown; readonly agent?: StudioExecutionAgent }
const FILE_TOOLS = new Set(['read', 'read_image', 'write', 'edit', 'glob', 'grep'])
const CONTROL_TOOLS = new Set(['ask_user_question', 'todo_write', 'update_plan', 'set_todo', 'list_agents', 'spawn_agent', 'send_message', 'wait_agent', 'close_agent'])
export interface StudioExecutionPolicy { readRoot: string; readPaths?: () => readonly string[]; writablePaths?: readonly string[]; writablePrefixes?: readonly string[]; protectedPaths?: readonly string[]; coordinateWrites?: boolean; authorizeWrite?: () => Promise<void>; prototypeMaterials?: boolean }
interface ExecutionScope { readonly cwd: string; policy: StudioExecutionPolicy; active: boolean; readonly parent?: ExecutionScope }
const scopes = new WeakMap<StudioExecutionAgent, ExecutionScope>()
export function registerStudioExecutionScope(cwd: string, policy: StudioExecutionPolicy, agent: StudioExecutionAgent): () => void {
  const key = canonical(cwd)
  const prepared: StudioExecutionPolicy = {
    ...policy,
    readRoot: canonical(policy.readRoot),
    ...(policy.writablePaths ? { writablePaths: policy.writablePaths.map(relativePolicyPath) } : {}),
    ...(policy.writablePrefixes ? { writablePrefixes: policy.writablePrefixes.map(relativePolicyPath) } : {}),
    ...(policy.protectedPaths ? { protectedPaths: policy.protectedPaths.map(relativePolicyPath) } : {}),
  }
  if (path.parse(prepared.readRoot).root === prepared.readRoot) throw new Error('Agent 读取范围不能是整个文件系统根。')
  if (!under(prepared.readRoot, key)) throw new Error('Agent 工作目录必须位于受管理读取范围。')
  if (!agent?.session.header.cwd || canonical(agent.session.header.cwd) !== key) throw new Error('Agent 身份与任务工作目录不一致。')
  if (scopes.has(agent)) throw new Error('Agent 已绑定工作台任务范围。')
  const binding: ExecutionScope = { cwd: key, policy: prepared, active: true }
  scopes.set(agent, binding)
  return () => { binding.active = false; if (scopes.get(agent) === binding) scopes.delete(agent) }
}
/** Replace the live task's write scope after the Host has recorded its updated authorization. */
export function updateStudioWriteScope(agent: StudioExecutionAgent, paths: readonly string[], prefixes: readonly string[], authorizeWrite?: () => Promise<void>): void {
  const scope = scopes.get(agent)
  if (!scope || !active(scope)) throw new Error('会话没有有效的任务写入范围')
  scope.policy.writablePaths = paths.map(relativePolicyPath)
  scope.policy.writablePrefixes = prefixes.map(relativePolicyPath)
  if (authorizeWrite) scope.policy.authorizeWrite = authorizeWrite
  else delete scope.policy.authorizeWrite
}
function active(binding: ExecutionScope): boolean { return binding.active && (!binding.parent || active(binding.parent)) }
/** Only the Host's verified live registry parent/child edge may call this. */
export function inheritStudioExecutionScope(parent: StudioExecutionAgent, child: StudioExecutionAgent): (() => void) | undefined {
  const source = scopes.get(parent)
  if (!source || !active(source)) return undefined
  if (!child.session.header.cwd || canonical(child.session.header.cwd) !== source.cwd) throw new Error('子 Agent 只能继承当前工作台任务目录。')
  if (scopes.has(child)) throw new Error('子 Agent 已绑定工作台任务范围。')
  const binding: ExecutionScope = { cwd: source.cwd, policy: source.policy, active: true, parent: source }
  scopes.set(child, binding)
  return () => { binding.active = false; if (scopes.get(child) === binding) scopes.delete(child) }
}
function canonical(value: string): string {
  const suffix: string[] = []
  let ancestor = path.resolve(value)
  while (true) {
    try { return path.join(realpathSync.native(ancestor), ...suffix.reverse()) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw error
      suffix.push(path.basename(ancestor)); ancestor = parent
    }
  }
}
function under(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function relativePolicyPath(value: string): string {
  value = value.replace(/\/$/, '')
  if (!value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Agent 文件范围必须使用受管理根下的相对路径。')
  return value
}
function matches(relative: string, entries: readonly string[], prefix: boolean): boolean {
  return entries.some(entry => relative === entry || (prefix && relative.startsWith(`${entry}/`)))
}
function noEscapingLinks(root: string, target: string): void {
  let count = 0
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++count > 100_000) throw new Error('搜索范围过大，请缩小到业务目录。')
      if (entry.name.toLowerCase() === '.git') continue
      const filename = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) { if (!under(root, canonical(filename))) throw new Error('搜索目录包含指向项目之外的链接。') }
      else if (entry.isDirectory()) visit(filename)
    }
  }
  if (lstatSync(target).isDirectory()) visit(target)
}

/** Install with the actual DSH ctx.tools.guard(); guards are monotonic after approval policies. */
export function createStudioToolGuard(): (execution: Readonly<GuardExecution>) => string | undefined {
  return execution => {
  const cwd = execution.agent?.session.header.cwd
  if (!cwd || !path.isAbsolute(cwd)) return 'Agent 尚未绑定受管理项目目录。'
  let policy: StudioExecutionPolicy | undefined
  try {
    const binding = execution.agent && scopes.get(execution.agent)
    if (binding && active(binding) && binding.cwd === canonical(cwd)) policy = binding.policy
  } catch { return 'Agent 受管理执行范围无效。' }
  if (!policy) return 'Agent 尚未绑定工作台任务及允许的文件范围。'
  if (execution.name === 'spawn_agent') {
    const args = execution.arguments
    if (!args || typeof args !== 'object' || Array.isArray(args)) return '子 Agent 参数无效。'
    const requested = (args as Record<string, unknown>).cwd
    if (requested !== undefined && (typeof requested !== 'string' || !requested.trim() || requested.includes('\0'))) return '子 Agent 工作目录无效。'
    try {
      const current = canonical(cwd)
      const target = requested === undefined ? current : canonical(path.resolve(current, requested as string))
      if (target !== current || !statSync(target).isDirectory()) return '子 Agent 只能继承当前工作台任务目录。'
    } catch { return '无法验证子 Agent 工作目录。' }
  }
  if (CONTROL_TOOLS.has(execution.name)) return undefined
  if (execution.name === 'prototype_requirement_catalog' || execution.name === 'prototype_read_requirement') return policy.prototypeMaterials ? undefined : '此会话没有原型需求读取权限。'
  if (!FILE_TOOLS.has(execution.name)) return '工作台禁止普通 Agent 执行任意命令、程序或宿主扩展操作；请使用工作台专用检查、预览及发布入口。'
  const args = execution.arguments as Record<string, unknown> | null
  const value = args?.file_path ?? args?.path ?? '.'
  if (typeof value !== 'string' || value.includes('\0')) return '文件路径无效。'
  try {
    const root = canonical(policy.readRoot)
    if (!statSync(root).isDirectory()) return '项目目录不可用。'
    const target = canonical(path.resolve(cwd, value))
    // Host imports live outside Git; only exact selected files are readable.
    if ((execution.name === 'read' || execution.name === 'read_image') && policy.readPaths?.().some(filename => path.isAbsolute(filename) && canonical(filename) === target) && statSync(target).isFile()) return undefined
    const relative = path.relative(root, target)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep).some(part => part.toLowerCase() === '.git')) return '普通 Agent 只能访问当前项目目录中的业务文件。'
    if (execution.name === 'write' || execution.name === 'edit') {
      const actual = relative.split(path.sep).join('/')
      const logical = path.relative(root, path.resolve(cwd, value)).split(path.sep).join('/')
      const protectedPaths = policy.protectedPaths ?? []
      if (matches(actual, protectedPaths, true) || matches(logical, protectedPaths, true)) return '此文件属于工作台固定契约，Agent 无权修改。'
      if (!matches(actual, policy.writablePaths ?? [], false) && !matches(actual, policy.writablePrefixes ?? [], true)) return '此任务只能修改已授权的材料或原型业务文件。'
    }
    if (execution.name === 'glob' || execution.name === 'grep') noEscapingLinks(root, target)
  } catch { return '无法验证文件路径位于当前项目中。' }
  return undefined
  }
}
export const studioToolGuard = createStudioToolGuard()

/** Keep native prototype writes inside the same path lock as the workbench editor. */
export async function coordinateStudioToolWrite<T>(execution: Readonly<GuardExecution> & { readonly signal: AbortSignal }, next: () => Promise<T>): Promise<T> {
  if (execution.name !== 'write' && execution.name !== 'edit') return next()
  const binding = execution.agent && scopes.get(execution.agent)
  if (!binding?.policy.coordinateWrites) return next()
  const args = execution.arguments as Record<string, unknown> | null
  const value = args?.file_path ?? args?.path
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('文件路径无效。')
  const target = path.resolve(binding.cwd, value), lockedPath = canonicalWritePath(target)
  return withPathWriteLock(target, async () => {
    execution.signal.throwIfAborted()
    const authorizeWrite = binding.policy.authorizeWrite
    if (!authorizeWrite) throw new Error('原型事项缺少后台授权核对，现场已保留。')
    await authorizeWrite()
    if (binding.policy.authorizeWrite !== authorizeWrite) throw new Error('原型事项授权在写入前发生变化，请重新核对。')
    execution.signal.throwIfAborted()
    const reason = studioToolGuard(execution)
    if (reason) throw new Error(reason)
    if (canonicalWritePath(target) !== lockedPath) throw new Error('文件路径在等待写入期间发生变化，请重新读取。')
    return next()
  })
}
