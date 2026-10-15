import { resolve } from 'node:path';
import { defineConfig } from 'umi';
import { loadPrototypeRoutes } from './load-routes';
import { PrototypeResourceFencePlugin } from './resource-fence';

export default defineConfig({
  npmClient: 'pnpm',
  history: { type: 'hash' },
  base: '/',
  publicPath: process.env.NODE_ENV === 'production' ? './' : '/',
  outputPath: 'dist',
  mountElementId: 'eadp-prototype',
  hash: true,
  mfsu: false,
  mock: false,
  plugins: ['@umijs/plugins/dist/locale'],
  locale: { default: 'zh-CN', baseNavigator: false, antd: false },
  routes: [{ path: '/', component: '@/layouts/BlankLayout', routes: loadPrototypeRoutes(resolve(__dirname, '..')) }],
  chainWebpack(memo) {
    memo.plugin('eadp-prototype-resource-fence').use(PrototypeResourceFencePlugin);
  },
  title: '需求原型',
  alias: { '@': resolve(__dirname, '../src') },
  headScripts: [{ src: './prototype-guard.js' }],
  metas: [
    {
      'http-equiv': 'Content-Security-Policy',
      content: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'self'",
    },
    { name: 'eadp-prototype', content: 'synthetic-only-v1' },
  ],
  extraBabelPlugins: [
    [
      '@ead/babel-plugin-suid-import',
      { libraryName: '@ead/suid', libraryDirectory: 'es', styleLibraryDirectory: 'es' },
      '@ead/suid',
    ],
  ],
  lessLoader: { javascriptEnabled: false, disablePluginRule: true, math: 'always' },
});
