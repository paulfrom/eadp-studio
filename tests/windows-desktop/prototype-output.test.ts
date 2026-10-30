import assert from 'node:assert/strict'
import test from 'node:test'
import { capturePrototypeOutput } from '../../packages/studio-plugin/src/host/prototype/output.ts'
import type { ManagedProcess } from '../../packages/studio-plugin/src/host/adapters/platform/runtime.ts'

test('a rejected progress save does not poison the final process snapshot', async () => {
  let emit!: (channel: 'stdout' | 'stderr', text: string) => void
  const process = { onOutput: (listener: typeof emit) => { emit = listener; return () => {} } } as ManagedProcess
  const saved: string[] = []; let calls = 0
  const capture = capturePrototypeOutput(process, async value => {
    if (++calls === 1) throw new Error('temporary save failure')
    saved.push(value.stdout)
  })
  try {
    emit('stdout', 'before'); await assert.rejects(capture.flush(), /temporary save failure/)
    emit('stdout', ' after'); await capture.flush()
    assert.deepEqual(saved, ['before after'])
  } finally { capture.dispose() }
})

test('failure of the final snapshot still rejects instead of reporting success', async () => {
  const process = { onOutput: () => () => {} } as unknown as ManagedProcess
  const capture = capturePrototypeOutput(process, async () => { throw new Error('unwritable') })
  try { await assert.rejects(capture.flush(), /unwritable/); await assert.rejects(capture.flush(), /unwritable/) }
  finally { capture.dispose() }
})
