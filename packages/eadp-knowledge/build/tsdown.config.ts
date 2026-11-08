import { isAbsolute } from 'node:path'
import { clientBundle } from '../../client/tsdown.client.ts'

/** 裸说明符（第三方解析器与 Node 内置模块）保持运行时 import；文件路径一律打包。 */
const isBareSpecifier = (specifier: string) =>
  !specifier.startsWith('.') && !specifier.startsWith('\0') && !isAbsolute(specifier)

/** 导入转换 worker 的独立入口：Host 只传原件字节，解析与渲染都在工作线程内完成。 */
const convertWorker = {
  name: '@eadp/knowledge/convert-worker',
  entry: { 'convert-worker': 'lib/types/host/convert/worker.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // 按说明符判定内外置：本包自己的相对模块全部打包，第三方与内置模块留给真实安装。
  deps: {
    neverBundle: isBareSpecifier,
    alwaysBundle: (specifier: string) => !isBareSpecifier(specifier),
  },
}

export default clientBundle(import.meta.dirname, ['lib/types/host/index.js'], {
  hostPhase: true,
  companions: [convertWorker],
})
