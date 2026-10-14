/*
 * @Author: Eason
 * @Date: 2020-02-21 18:03:16
 * @Last Modified by: Eason
 * @Last Modified time: 2025-08-07 18:17:34
 */
import type { Locale } from '@ead/suid/es/locale';
import enUS from '@ead/suid/lib/locale/en_US';
import zhCN from '@ead/suid/lib/locale/zh_CN';
import { base } from '../../public/app.config.json';

/** 服务接口基地址，默认是当前站点的域名地址 */
const BASE_DOMAIN = '/';

/** 网关地址 */
const GATEWAY = 'api-gateway';

/**
 * 非生产环境下是使用mocker开发，还是与真实后台开发或联调
 * 注：
 *    yarn start 使用真实后台开发或联调
 *    yarn start:mock 使用mocker数据模拟
 */
const getServerPath = () => {
  if (process.env.NODE_ENV !== 'production') {
    if (process.env.MOCK === 'yes') {
      return '/mocker.api';
    }
    // 在config.js define 中声明，本地开发时，可通过config.local.js 进行覆盖
    return process.env.DEV_GATEWAY;
  }
  return `${BASE_DOMAIN}${GATEWAY}`;
};

/** 项目的站点基地址 */
const APP_BASE = base;

/** 站点的地址，用于获取本站点的静态资源如json文件，xls数据导入模板等等 */
const LOCAL_PATH = process.env.NODE_ENV !== 'production' ? `../${APP_BASE}` : `../${APP_BASE}`;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SERVER_PATH = getServerPath();

const SEI_AUTH_SERVER_PATH = `${SERVER_PATH}/sei-basic`;
const SEI_BASIC_SERVER_PATH = `${SERVER_PATH}/sei-basic`;

const LANG = {
  'en-US': enUS,
  'zh-CN': zhCN,
} as Record<string, Locale>;

const LOGIN_STATUS: Record<string, string> = {
  SUCCESS: 'success',
  MULTI_TENANT: 'multiTenant',
  CAPTCHA_ERROR: 'captchaError',
  FROZEN: 'frozen',
  LOCKED: 'locked',
  FAILURE: 'failure',
};

/** 业务模块功能项示例 */
const APP_MODULE_BTN_KEY: Record<string, string> = {
  CREATE: `${APP_BASE}_CREATE`,
  EDIT: `${APP_BASE}_EDIT`,
  DELETE: `${APP_BASE}_DELETE`,
};

export default {
  APP_BASE,
  LOCAL_PATH,
  SERVER_PATH,
  APP_MODULE_BTN_KEY,
  LOGIN_STATUS,
  IS_PRODUCTION,
  SEI_AUTH_SERVER_PATH,
  SEI_BASIC_SERVER_PATH,
  LANG,
};
