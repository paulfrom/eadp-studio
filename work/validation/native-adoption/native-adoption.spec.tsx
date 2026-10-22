import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SlotCore, type SlotRendererHost, type StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from '../../../.local/build/dsh/packages/client/ui-renderer/src/client/scoped-slots.tsx'
import { ScenarioDocumentService } from '../../../packages/studio-plugin/src/host/application/scenario-documents.ts'
import { digest, readMaterial, saveMaterial } from '../../../packages/studio-plugin/src/host/adapters/assets/materials.ts'
import type { ScenarioSuggestionBatch } from '../../../packages/studio-plugin/src/shared/scenarios.ts'

const observable = <T,>(value: T) => ({ getSnapshot: () => value, subscribe: () => () => {} })
const created: string[] = []
afterEach(async () => {
  cleanup()
  for (const directory of created.splice(0)) {
    const absolute = path.resolve(directory)
    if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('eadp-native-adoption-')) throw new Error('Unsafe cleanup path')
    await rm(absolute, { recursive: true, force: true })
  }
})

/** Real registry and real renderer; fixture implements only the host's session-source adapter. */
function hostOver(core: SlotCore, sessionId: string): SlotRendererHost {
  const root = observable<StandardSourceBinding>({ key: undefined, hooks: {}, keyedHooks: {}, props: {} })
  const session = observable<StandardSourceBinding>({ key: sessionId, hooks: {}, keyedHooks: {}, props: { sessionId } })
  return {
    subscribe: (key, fn) => core.subscribe(key, fn), getVersion: key => core.getVersion(key),
    entriesOf: key => core.entries(key), entriesOfSlot: key => core.entriesOfSlot(key),
    reportEntryError: (key, entry, error, info) => { core.reportEntryError(key, entry, error, info) },
    reportFactoryError: (name, definition, error) => { core.reportFactoryError(name, definition, error) },
    specOf: key => core.specDynamic(key), isLive: entry => core.isLive(entry),
    storeOf: () => undefined, factoryStoreOf: () => undefined, retainFactoryOccurrence: () => () => {},
    subscribeFactory: (name, fn) => core.subscribeFactory(name, fn), getFactoryVersion: name => core.factoryVersion(name),
    factoryOf: name => core.factory(name), isFactoryLive: definition => core.isFactoryLive(definition),
    root, scopeRevision: observable(0),
    scope: () => ({ current: session, bindingSource: () => session,
      renderArea: (_binding, { children }) => <>{children}</>,
    }),
  }
}

it('native session slot button dispatches injected adoption, writes real MD, and rejects a stale batch', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'eadp-native-adoption-')); created.push(parent)
  const root = path.join(parent, 'project'); await mkdir(root)
  const service = new ScenarioDocumentService(path.join(parent, 'local'))
  const draft = await saveMaterial(root, {
    entityId: 'probe-scene', kind: 'scenario', title: '原生采纳验证', templateId: 'default',
    templateRef: { commitSha: 'a'.repeat(40), path: '.template/default.md', sha256: 'b'.repeat(64) },
    scenarioIds: [], prerequisites: [], sources: [], businessEvidence: [],
    coreRulesPresent: false, acceptanceCriteriaPresent: false, openQuestions: [], referencedAssets: [],
  }, '## 规则\n旧规则')
  const batch: ScenarioSuggestionBatch = {
    id: 'probe-batch', entityId: draft.entityId, baseHash: draft.sha256, status: 'current',
    groups: [{ id: 'rules', title: '规则', items: [{ id: 'item-one', start: 6, end: 9,
      original: '旧规则', replacement: '采纳后的业务规则', evidenceIds: [] }] }],
  }
  const dispatched: object[] = []
  let current = draft
  const core = new SlotCore()
  const slot = 'conversation.chat.assistant-actions'
  core.register({ name: 'root', children: { [slot]: { kind: 'list', scope: 'session' } } },
    ({ renderSlot }: { renderSlot: (key: string, owner: object) => ReactNode }) => <section>{renderSlot(slot, { messageId: 'probe-message' })}</section>)
  core.register({ name: slot, id: 'probe-adoption', inject: (sessionId: string) => ({
    adopt: async (messageId: string) => {
      dispatched.push({ sessionId, messageId, itemId: 'item-one' })
      current = await service.apply({ root, draft: current, batch, selectedItemIds: ['item-one'],
        expectedHash: current.sha256, operationId: `adopt-${dispatched.length}`, readEvidenceIds: [] })
    },
  }) }, ({ adopt, messageId }: { adopt: (messageId: string) => Promise<void>; messageId: string }) => {
    const [status, setStatus] = useState('待采纳')
    return <><button onClick={() => { void adopt(messageId).then(() => setStatus('已采纳'), error => setStatus(error.message)) }}>采纳</button><output>{status}</output></>
  })
  const view = render(<>{createSlotRenderer().renderRoot(hostOver(core, 'probe-session'), {})}</>)
  expect(view.getByRole('button', { name: '采纳' })).toBeTruthy()
  expect((await readMaterial(root, 'scenario', draft.entityId)).body).toBe(draft.body)
  await act(async () => { fireEvent.click(view.getByRole('button', { name: '采纳' })); await new Promise(resolve => setTimeout(resolve, 100)) })
  expect(view.container.textContent).toContain('已采纳')
  expect(dispatched).toEqual([{ sessionId: 'probe-session', messageId: 'probe-message', itemId: 'item-one' }])
  const saved = await readMaterial(root, 'scenario', draft.entityId)
  expect(saved.body).toBe('## 规则\n采纳后的业务规则')
  expect(saved.sha256).not.toBe(draft.sha256)
  expect(saved.sha256).toBe(digest(await readFile(path.join(root, saved.path))))
  await act(async () => { fireEvent.click(view.getByRole('button', { name: '采纳' })); await new Promise(resolve => setTimeout(resolve, 100)) })
  expect(view.container.textContent).toMatch(/过期|版本|变化|失效/)
  expect((await readMaterial(root, 'scenario', draft.entityId)).sha256).toBe(saved.sha256)
  await writeFile(path.join(import.meta.dirname, 'result.json'), JSON.stringify({
    passed: true, nativeSlot: slot, sessionId: 'probe-session', messageId: 'probe-message',
    beforeHash: draft.sha256, afterHash: saved.sha256, body: saved.body,
    staleRejection: view.container.textContent, callbacks: dispatched.length,
    boundaries: ['Real SlotCore and UI renderer with fixture host/session adapter and jsdom DOM',
      'Real ScenarioDocumentService.apply and temporary Markdown file',
      'No desktop app, Remote transport, Studio command, buffer flush/receive, or model reply ingestion tested'],
  }, null, 2))
})
