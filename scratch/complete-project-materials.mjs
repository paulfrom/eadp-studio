/** Exercise one project's scenario-to-requirement flow through the real desktop Host. */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readMaterial } from '../packages/studio-plugin/src/host/adapters/assets/materials.ts'

const [projectId, scenarioTitle, requirementTitle] = process.argv.slice(2)
if (!projectId || !scenarioTitle || !requirementTitle) throw new Error('Usage: complete-project-materials.mjs <projectId> <scenarioTitle> <requirementTitle>')
const environment = { ...process.env, STUDIO_CDP_ORIGIN: process.env.STUDIO_CDP_ORIGIN ?? 'http://127.0.0.1:9224' }
const call = command => {
  const output = execFileSync(process.execPath, ['scratch/studio-command.mjs', JSON.stringify(command)], { cwd: process.cwd(), env: environment, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
  const reply = JSON.parse(output)
  if (!reply?.ok) throw new Error(reply?.message ?? `${command.action} failed`)
  return reply.state
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const entity = (state, id) => state.collaboration.entities.find(value => value.id === id)
const task = (state, id) => state.tasks.find(value => value.entityId === id)
const operation = (state, id) => state.pending.find(value => value.entityId === id && !['accepted'].includes(value.phase))
const waitAccepted = async (id, kind) => {
  for (let index = 0; index < 60; index++) {
    const state = await call({ action: 'state' }), current = entity(state, id)
    if (current?.confirmationStatus === 'confirmed' && current.current) return current
    const pending = operation(state, id)
    if (pending) {
      if (pending.phase === 'recovery' || pending.phase === 'unknown' || pending.phase === 'rejected') throw new Error(pending.message)
      await call({ action: 'retryOperation', operationId: pending.id })
    }
    await sleep(2000)
  }
  throw new Error(`${kind} confirmation did not settle`)
}
const addEvidence = async (id, worktree, sourceId) => {
  const text = `项目协同验证记录\n场景：${scenarioTitle}\n需求：${requirementTitle}\n记录：用于验证项目场景、需求、正式依据、固定提交和后台接受链路。\n`
  await call({ action: 'importScenarioSource', entityId: id, name: '项目协同验证记录.txt', base64: Buffer.from(text).toString('base64'), operationId: sourceId })
  for (let index = 0; index < 20; index++) {
    const state = await call({ action: 'state' }), source = state.materialSources?.find(value => value.entityId === id)?.sources.find(value => value.id === sourceId)
    if (source && ['read', 'partial'].includes(source.status)) break
    if (source?.status === 'failed') throw new Error(source.error)
    await sleep(500)
  }
  await call({ action: 'selectScenarioSource', entityId: id, sourceId, selected: true, formal: true })
  return readMaterial(worktree, 'scenario', id).catch(() => undefined)
}

await call({ action: 'openProject', projectId })
await sleep(1000)
const scenarioOperationId = randomUUID()
let state = await call({ action: 'createMaterial', kind: 'scenario', title: scenarioTitle, scenarioIds: [], operationId: scenarioOperationId })
let current = state.collaboration.entities.find(value => value.title === scenarioTitle && value.kind === 'scenario')
if (!current) throw new Error('Scenario was not created')
const scenarioId = current.id, scenarioWorktree = task(state, scenarioId).worktree
await addEvidence(scenarioId, scenarioWorktree, randomUUID())
let draft = await readMaterial(scenarioWorktree, 'scenario', scenarioId)
const scenarioBody = `# ${scenarioTitle}\n\n## 目标与范围\n\n验证资产入库场景从正文整理、正式依据到固定确认的完整协同流程。\n\n## 角色\n\n- 责任单位：提交资产入库信息并核对结果。\n\n## 流程\n\n1. 责任单位提交资产入库信息。\n2. 系统校验并保存材料及正式依据。\n3. 作者确认后，项目接受固定场景版本，供需求关联。\n\n## 业务规则\n\n- 同一资产入库信息只形成一个场景身份。\n- 场景确认必须保留实际正文和正式依据。\n\n## 异常\n\n- 校验或后台接受失败时保留本地材料，核对原操作后继续，不重复创建场景。\n\n## 验收条件\n\n- 场景正文和正式依据被同一固定提交接受。\n- 可以从该固定场景创建需求并保留来源关系。\n\n## 依据\n\n- 《项目协同验证记录.txt》。\n\n## 待澄清项\n\n- 无阻断项；具体业务字段在后续需求中明确。\n`
await call({ action: 'saveScenario', entityId: scenarioId, operationId: randomUUID(), body: scenarioBody, metadata: { ...draft.metadata, flowComplete: true } })
draft = await readMaterial(scenarioWorktree, 'scenario', scenarioId)
await call({ action: 'confirmMaterial', entityId: scenarioId, expectedHash: draft.sha256, method: 'direct' })
await waitAccepted(scenarioId, 'scenario')

state = await call({ action: 'createMaterial', kind: 'requirement', title: requirementTitle, scenarioIds: [scenarioId], operationId: randomUUID() })
current = state.collaboration.entities.find(value => value.title === requirementTitle && value.kind === 'requirement')
if (!current) throw new Error('Requirement was not created')
const requirementId = current.id, requirementWorktree = task(state, requirementId).worktree
await addEvidence(requirementId, requirementWorktree, randomUUID())
draft = await readMaterial(requirementWorktree, 'requirement', requirementId)
const requirementBody = `# ${requirementTitle}\n\n## 目标\n\n实现资产入库信息的一次提交和可追踪保存。\n\n## 范围\n\n包含资产入库信息提交、校验、保存和结果查询，不包含后续产权交易流程。\n\n## 流程\n\n1. 责任单位提交资产入库信息。\n2. 系统校验必填内容并保存。\n3. 查询结果返回同一资产入库身份及处理状态。\n\n## 字段\n\n- 资产名称：必填。\n- 资产类型：必填。\n- 责任单位：必填。\n\n## 业务规则\n\n- 同一资产只保留一个入库身份。\n- 保存结果必须可追踪到提交材料和固定场景来源。\n\n## 异常\n\n- 必填信息缺失时拒绝提交并保留输入。\n- 接受结果未知时先查询原操作，不重复创建需求。\n\n## 验收条件\n\n- 有效入库信息保存后可以按同一身份查询。\n- 需求及其正式依据被后台接受，并保留固定场景来源。\n\n## 来源\n\n- 固定场景《${scenarioTitle}》及《项目协同验证记录.txt》。\n\n## 待澄清项\n\n- 字段级校验规则在后续详细设计中明确。\n`
await call({ action: 'saveRequirement', entityId: requirementId, operationId: randomUUID(), body: requirementBody, metadata: { ...draft.metadata, summary: '实现资产入库信息的一次提交、校验和可追踪保存。', coreRulesPresent: true, acceptanceCriteriaPresent: true, openQuestions: [] } })
draft = await readMaterial(requirementWorktree, 'requirement', requirementId)
await call({ action: 'confirmRequirement', entityId: requirementId, operationId: randomUUID(), expectedHash: draft.sha256, body: draft.body, metadata: draft.metadata, method: 'direct' })
const accepted = await waitAccepted(requirementId, 'requirement')
console.log(JSON.stringify({ projectId, scenarioId, requirementId, requirement: accepted }, null, 2))
