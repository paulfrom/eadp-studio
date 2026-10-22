import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ScenarioFileObserver, type ScenarioFileEvent, type ScenarioObservedTask } from '../../packages/studio-plugin/src/host/application/scenario-file-observer.ts'

async function fixture(t: { after(fn: () => Promise<unknown>): unknown }) {
  const root = await mkdtemp(path.join(tmpdir(), 'eadp-scenario-observer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '场景'))
  const task: ScenarioObservedTask = { projectId: 'project', entityId: 'scene', worktree: root }
  const relative = '场景/合成场景.md', filename = path.join(root, relative)
  await writeFile(filename, '初稿')
  return { root, task, relative, filename }
}

test('directory observation survives repeated atomic replacements and stops after disposal', async t => {
  const f = await fixture(t), events: ScenarioFileEvent[] = []
  let next: (() => void) | undefined
  const observer = new ScenarioFileObserver(event => { events.push(event); next?.(); next = undefined })
  t.after(async () => observer.dispose())
  assert.equal(observer.observe(f.task, f.relative), true)
  const replacement = async (body: string) => {
    const arrived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('文件变更没有触发观察通知')), 1500)
      next = () => { clearTimeout(timer); resolve() }
    })
    const temporary = `${f.filename}.tmp`
    await writeFile(temporary, body); await rename(temporary, f.filename)
    await arrived
  }
  await replacement('第二稿'); await replacement('第三稿')
  assert.equal(events.length, 2)
  assert.ok(events.every(event => event.kind === 'changed' && event.task.entityId === f.task.entityId))
  observer.dispose()
  await writeFile(f.filename, '关闭后修改')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(events.length, 2)
})

test('a pending debounce is cancelled by unobserve and duplicate observations share their slot', async t => {
  const f = await fixture(t), events: ScenarioFileEvent[] = [], observer = new ScenarioFileObserver(event => events.push(event))
  t.after(async () => observer.dispose())
  assert.equal(observer.observe(f.task, f.relative), true); assert.equal(observer.observe(f.task, f.relative), true)
  await writeFile(f.filename, '即将停止观察的修改')
  observer.unobserve(f.task)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(events, [])
})

test('missing directories and capacity exhaustion explicitly report unavailable without evicting existing observations', async t => {
  const f = await fixture(t), events: ScenarioFileEvent[] = [], observer = new ScenarioFileObserver(event => events.push(event))
  t.after(async () => observer.dispose())
  assert.equal(observer.observe({ ...f.task, worktree: path.join(f.root, 'missing') }, f.relative), false)
  assert.equal(events[0]?.kind, 'unavailable')
  for (let index = 0; index < 128; index++) assert.equal(observer.observe({ ...f.task, entityId: `scene-${index}` }, `场景/scene-${index}.md`), true)
  assert.equal(observer.observe({ ...f.task, entityId: 'overflow' }, '场景/overflow.md'), false)
  assert.equal(events.at(-1)?.kind, 'unavailable')
  assert.match(events.at(-1)!.kind === 'unavailable' ? (events.at(-1)! as Extract<ScenarioFileEvent, { kind: 'unavailable' }>).message : '', /128/)
  observer.unobserve({ ...f.task, entityId: 'scene-0' })
  assert.equal(observer.observe({ ...f.task, entityId: 'overflow' }, '场景/overflow.md'), true)
})
