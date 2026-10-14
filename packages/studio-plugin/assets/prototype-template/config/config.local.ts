import { defineConfig } from 'umi';
import type { IConfig } from '@umijs/preset-umi';

/**
 * 不采用代理
 */
export default defineConfig({
  define: {
    'process.env.DEV_GATEWAY': 'https://ead.changhong.com/api-gateway',
  },
}) as IConfig;
