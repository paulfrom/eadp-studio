import path, { resolve } from 'path';
import { defineConfig } from 'umi';
import type { IConfig } from '@umijs/preset-umi';
import webpackPlugin from './plugin.config';
import proxy from './proxy.config';
import pageRoutes from './router.config';
import themeConfig from './theme.config';

const appConfigPath = path.join(__dirname, '../public/app.config.json');
const pkg = path.join(__dirname, '../package.json');
const { base } = require(appConfigPath);
const { name, title } = require(pkg);

export default defineConfig({
  npmClient: 'pnpm',
  history: {
    type: 'hash',
  },
  historyWithQuery: {},
  conventionLayout: false,
  fastRefresh: true,
  ignoreMomentLocale: true,
  jsMinifierOptions: { charset: 'utf8' },
  cssMinifierOptions: { charset: 'utf8' },
  base: `${base}/`,
  publicPath: `${base}/`,
  mountElementId: name,
  hash: true,
  esbuildMinifyIIFE: true,
  mfsu: {
    shared: {
      react: {
        singleton: true,
      },
    },
  },
  plugins: [
    'umi-plugin-keep-alive',
    '@umijs/plugins/dist/dva',
    '@umijs/plugins/dist/qiankun',
    '@umijs/plugins/dist/locale',
  ],
  codeSplitting: {
    jsStrategy: 'granularChunks',
  },
  title,
  dva: {
    skipModelValidate: true,
  },
  locale: {
    default: 'zh-CN',
    // default true, when it is true, will use `navigator.language` overwrite default
    baseNavigator: true,
  },
  qiankun: {
    slave: {},
  },
  routes: pageRoutes,
  proxy,
  theme: themeConfig(),
  alias: {
    '@': resolve(__dirname, './src'),
  },
  define: {
    'process.env.MOCK': process.env.MOCK,
    'process.env.DEV_GATEWAY': '/api-gateway',
  },
  externals: {
    chevrotain: 'chevrotain',
  },
  extraBabelPlugins: [
    [
      '@ead/babel-plugin-suid-import',
      {
        libraryName: '@ead/suid',
        libraryDirectory: 'es',
        styleLibraryDirectory: 'es',
      },
      '@ead/suid',
    ],
  ],
  lessLoader: {
    javascriptEnabled: true,
    math: 'always',
  },
  manifest: {
    basePath: '/',
  },
  chainWebpack: webpackPlugin,
}) as IConfig;
