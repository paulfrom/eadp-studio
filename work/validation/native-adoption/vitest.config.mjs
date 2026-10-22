import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const dsh = path.join(repo, '.local/build/dsh')
export default {
  root: repo,
  resolve: { alias: {
    'react': path.join(dsh, 'packages/client/ui-renderer/node_modules/react'),
    'react-dom': path.join(dsh, 'packages/client/ui-renderer/node_modules/react-dom'),
    'vitest': path.join(dsh, 'node_modules/vitest/dist/index.js'),
    '@testing-library/react': path.join(dsh, 'node_modules/@testing-library/react/dist/index.js'),
    '@deepseek-ai/dsh-client-ui-slots': path.join(dsh, 'packages/client/ui-slots/src/index.ts'),
    '@eadp/asset-domain': path.join(repo, 'packages/asset-domain/src/index.ts'),
    '@eadp/contracts': path.join(repo, 'packages/contracts/src/index.ts'),
  } },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['work/validation/native-adoption/native-adoption.spec.tsx'],
    environment: 'jsdom',
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 15000,
  },
}
