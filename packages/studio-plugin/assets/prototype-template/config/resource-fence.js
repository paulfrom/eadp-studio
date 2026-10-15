import { realpathSync } from 'node:fs'
import path from 'node:path'

const PLUGIN = 'EadpPrototypeResourceFence'

function within(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function resourcePath(request) {
  if (typeof request !== 'string') throw new Error('Prototype build resource request is invalid')
  const resourceRequest = request.slice(request.lastIndexOf('!') + 1)
  const query = resourceRequest.indexOf('?')
  const fragment = resourceRequest.indexOf('#')
  const end = [query, fragment].filter(index => index >= 0).reduce((min, index) => Math.min(min, index), resourceRequest.length)
  return resourceRequest.slice(0, end).replace(/\.webpack\[[^\]]+\]$/, '')
}

function isUriScheme(resource) {
  return !path.win32.isAbsolute(resource) && /^[a-z][a-z\d+.-]*:/i.test(resource)
}

function createFence() {
  const root = realpathSync.native(process.cwd())

  function resolveAllowed(request) {
    const resource = resourcePath(request)
    if (resource.includes('\0')) return
    if (!resource || isUriScheme(resource)) throw new Error('Prototype build resource scheme is not allowed')
    let target
    try {
      target = realpathSync.native(resource)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const extension = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.less', '.css']
        .map(suffix => { try { return realpathSync.native(`${resource}${suffix}`) } catch { return null } })
        .find(Boolean)
      if (!extension) throw error
      target = extension
    }
    const relative = path.relative(root, target)
    const parts = relative.split(path.sep).map(part => part.toLowerCase())
    if (!within(root, target) || parts.some(part => part === '.git' || part === '.env' || part.startsWith('.env.') || part === '.npmrc') || /\.(?:pem|key|p12|pfx|keystore|sqlite|db)$/i.test(target)) {
      throw new Error('Prototype build resource is outside the permitted source boundary')
    }
  }

  return {
    apply(compiler) {
      compiler.hooks.normalModuleFactory.tap(PLUGIN, factory => {
        factory.hooks.beforeResolve.tap(PLUGIN, data => {
          if (!data) return
          const request = String(data.request ?? '')
          const resource = resourcePath(request)
          if (isUriScheme(resource)) throw new Error('Prototype build resource scheme is not allowed')
          if (path.isAbsolute(resource) || path.win32.isAbsolute(resource)) resolveAllowed(resource)
        })
        factory.hooks.afterResolve.tap(PLUGIN, data => {
          if (!data) return
          const createData = data.createData
          if (!createData || typeof createData.resource !== 'string') throw new Error('Prototype build did not resolve a file resource')
          resolveAllowed(createData.resource)
        })
      })

      compiler.hooks.contextModuleFactory.tap(PLUGIN, factory => {
        factory.hooks.afterResolve.tap(PLUGIN, data => {
          if (!data) return
          if (typeof data.resource !== 'string') throw new Error('Prototype build context is invalid')
          resolveAllowed(data.resource)
        })
      })
    },
  }
}

export class PrototypeResourceFencePlugin {
  apply(compiler) {
    createFence().apply(compiler)
  }
}
