import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'

const repo = path.resolve('d:/project/ead/eadp-e2e')
const prepared = path.join(repo, '.local/build/dsh')
const modules = path.join(prepared, 'node_modules/.pnpm/node_modules')
const projectDir = path.join(prepared, 'apps/desktop/.desktop-build/development/project')
const installAnchor = path.join(modules, '@deepseek-ai/dsh/package.json')

console.log('ProjectDir:', projectDir)
console.log('InstallAnchor:', installAnchor)

const boot = await import(pathToFileURL(path.join(modules, '@deepseek-ai/dsh-app-boot/lib/index.js')))
const { runProfile } = await import(pathToFileURL(path.join(modules, '@deepseek-ai/dsh/lib/profile-boot.js')))

// Hook CollaborationSession and StudioService if possible
const pluginPath = path.join(prepared, 'packages/eadp/studio-plugin/lib/index.js')
console.log('PluginPath exists:', pluginPath)

const profile = boot.loadProfileDirectory('dsh', projectDir, installAnchor)
console.log('Profile loaded bundles:', profile.bundles)
console.log('Profile layers:', profile.layers.map(l => l.packageName))

// Set up process.argv[4] so PlatformRuntime can locate runtimeRoot if needed
process.argv[2] = prepared
process.argv[3] = projectDir
process.argv[4] = path.join(prepared, 'apps/desktop/.desktop-build/targets/win-x64/runtime/primary-runtime')

const app = await runProfile({
  environment: boot.loadLayeredEnv('dsh'),
  profile: 'desktop',
  resolvedProfile: { profile, installAnchor },
  patchFiles: [],
  args: ['--no-open', '--host', '127.0.0.1', '--port', '0']
})

try {
  console.log('Waiting for loader.await()...')
  await app.ctx.loader.await()
  await Promise.resolve()

  const entries = [...app.ctx.loader.entries()]
  console.log('All loader entries count:', entries.length)

  // Find StudioService instances
  let studioServices = []
  function searchFibers(fiber) {
    if (!fiber) return
    if (fiber.plugin?.name === 'StudioService' || fiber.plugin?.prototype instanceof (app.ctx.typertRemote?.TypertRemoteService ?? class {})) {
      studioServices.push(fiber)
    }
    // check services or instances
    if (fiber.ctx) {
      for (const key of Object.keys(fiber.ctx)) {
        const val = fiber.ctx[key]
        if (val && typeof val === 'object' && val.constructor?.name === 'StudioService') {
          studioServices.push({ fiber, instance: val })
        }
      }
    }
  }

  for (const entry of entries) {
    if (entry.fiber) {
      searchFibers(entry.fiber)
      // Check children
      if (entry.fiber.children) {
        for (const child of entry.fiber.children) {
          searchFibers(child)
        }
      }
    }
  }

  // Also search through registry
  const registry = app.ctx.registry
  console.log('Registry size:', registry?.size)
  if (registry) {
    for (const [plugin, fiber] of registry.entries()) {
      if (plugin?.name === 'StudioService' || plugin?.toString().includes('StudioService')) {
        console.log('Found in registry plugin:', plugin.name, 'fiber state:', fiber?.state)
        // Check if there is an instance
        console.log('Fiber properties:', Object.keys(fiber))
        studioServices.push(fiber)
      }
    }
  }

  // Find StudioService fiber
  for (const [plugin, runtime] of registry.entries()) {
    if (plugin?.name === 'StudioService') {
      console.log('Found StudioService in registry! Runtime fibers:', runtime.fibers.length)
      for (const fiber of runtime.fibers) {
        console.log('Fiber uid:', fiber.uid, 'state:', fiber.state)
        console.log('Fiber store keys:', Object.keys(fiber.store || {}))
        // In Cordis class plugin, instance is in fiber.store or fiber.store.value or similar
        // Or fiber.ctx
        let instance = fiber.store?.value || fiber.store || fiber.ctx?.['studio']
        console.log('Potential instance:', instance)
        // Let's inspect all values in fiber.store
        for (const [k, v] of Object.entries(fiber.store || {})) {
          console.log(`store[${k}]:`, v?.constructor?.name)
          if (v && v.command) instance = v
        }
        if (!instance || !instance.application) {
          // let's check fiber properties
          for (const prop of Object.getOwnPropertyNames(fiber)) {
            console.log('fiber property:', prop, typeof fiber[prop])
          }
        }
        console.log('Instance constructor:', instance?.constructor?.name)
        console.log('Instance keys:', instance ? Object.getOwnPropertyNames(instance) : null)
        console.log('Instance application:', instance?.application)
        
        const studioInstance = fiber.store?.studio?.value
        console.log('StudioService instance:', studioInstance?.constructor?.name)
        console.log('Application promise:', studioInstance?.application)
        
        if (studioInstance?.application) {
          console.log('Racing studioInstance.application...')
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('APPLICATION_TIMEOUT_3S')), 3000))
          try {
            const appResult = await Promise.race([studioInstance.application, timeout])
            console.log('>>> studioInstance.application RESOLVED! Constructor:', appResult?.constructor?.name)

            console.log('Testing studioInstance.command({ action: "state" })...')
            const commandTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('COMMAND_STATE_TIMEOUT_3S')), 3000))
            const cmdStart = Date.now()
            try {
              const stateResult = await Promise.race([studioInstance.command({ action: 'state' }), commandTimeout])
              console.log('>>> studioInstance.command state RESOLVED in', Date.now() - cmdStart, 'ms:', JSON.stringify(stateResult))
            } catch (cmdErr) {
              console.error('>>> studioInstance.command state HUNG OR FAILED in', Date.now() - cmdStart, 'ms:', cmdErr.message)
            }
          } catch (err) {
            console.error('>>> studioInstance.application RACE RESULT:', err.message, err.stack)
          }
        }
      }
    }
  }

} finally {
  console.log('Shutting down app...')
  await app.shutdown.shutdown(0)
  console.log('Shutdown complete.')
}
