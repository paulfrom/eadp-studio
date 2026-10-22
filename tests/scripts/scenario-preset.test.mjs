import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Uses the staged native DSH libraries without opening UI or making model calls.
const root = path.resolve(import.meta.dirname, '../..'), build = path.join(root, '.local/build/dsh')
const require = createRequire(path.join(build, 'packages/preset/agent-preset-registry/package.json'))
const native = async name => import(pathToFileURL(require.resolve(name)).href)

test('the shipped skill snapshot carries the grill stub and both skills it calls', async () => {
  const skills = path.join(root, 'packages/studio-plugin/assets/skills')
  const read = name => readFile(path.join(skills, name, 'SKILL.md'), 'utf8')
  const [stub, grilling, domain] = await Promise.all([read('grill-with-docs'), read('grilling'), read('domain-modeling')])
  assert.match(stub, /"grilling" and "domain-modeling"/, 'the stub must keep calling both skills')
  assert.match(grilling, /^---\n[\s\S]*name: grilling/m)
  assert.match(domain, /^---\n[\s\S]*name: domain-modeling/m)
  assert.equal(JSON.parse(await readFile(path.join(skills, 'SOURCE.json'), 'utf8')).commit.length >= 7, true)
})

test('the shipped scenario preset mounts native read-only tools and compaction without command execution tools', async () => {
  const { load } = require('js-yaml')
  const patch = load(await readFile(path.join(root, 'packages/studio-plugin/cordis.patch.yml'), 'utf8'))
  const definition = patch.flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'preset-eadp-scenario')?.config
  assert.equal(definition.id, 'eadp-scenario')
  const [{ Context }, { default: Loader }, { default: Group }, { default: Projections }, { default: Sessions },
    { default: SystemPrompt }, { default: Tools }, { default: Presets }, { createScope }] = await Promise.all([
    native('@deepseek-ai/cordis'), native('@deepseek-ai/cordis-plugin-loader'), native('@deepseek-ai/cordis-plugin-group'),
    native('@deepseek-ai/dsh-session-projection'), native('@deepseek-ai/dsh-session'), native('@deepseek-ai/dsh-system-prompt'),
    native('@deepseek-ai/dsh-tools'), native('@deepseek-ai/dsh-agent-preset-registry'), native('@deepseek-ai/dsh-scope'),
  ])
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(path.join(build, 'packages/bundle/web-app/package.json')).href
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await ctx.plugin(Projections); await ctx.plugin(Sessions)
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
    // Host service contracts are present; no filesystem/model operation is run.
    for (const name of ['fs', 'workingDirectory', 'attachments', 'llm', 'tokenMeter', 'subprocess', 'skills', 'agents']) ctx.provide(name, {})
    const commands = []
    ctx.provide('commands', { register: definition => { commands.push(definition.name); return () => {} } })
    await ctx.plugin(Presets, { default: 'eadp-scenario' })
    const unregister = await ctx.agentPresets.register(definition)
    const key = {}, scope = createScope(ctx, key)
    try {
      await ctx.agentPresets.mount(scope.ctx, 'eadp-scenario')
      const names = ctx.tools.schemas(key).map(tool => tool.name).sort()
      assert.deepEqual(names, ['glob', 'grep', 'read', 'read_image', 'skill'])
      for (const forbidden of ['write', 'edit', 'bash', 'pwsh', 'spawn_agent', 'subagent']) assert.equal(names.includes(forbidden), false)
      const compositions = ctx.agentPresets.inspectCompositions(scope.ctx)
      assert.equal(compositions.length, 1)
      assert.deepEqual(compositions[0].leakedServices, [])
      const modules = compositions[0].modules.map(module => module.moduleName)
      for (const module of ['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-compaction-tool-result-pruner', '@deepseek-ai/dsh-command-compact']) assert.ok(modules.includes(module), `native plugin ${module} must activate`)
      assert.deepEqual(commands, ['compact'])
    } finally { await scope.dispose(); await unregister() }
  } finally { await ctx.fiber.dispose() }
})
