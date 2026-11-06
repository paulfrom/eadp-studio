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
  extraBabelPlugins: [
    [
      '@ead/babel-plugin-suid-import',
      { libraryName: '@ead/suid', libraryDirectory: 'es', styleLibraryDirectory: 'es' },
      '@ead/suid',
    ],
  ],
  lessLoader: { javascriptEnabled: false, disablePluginRule: true, math: 'always' },
});
