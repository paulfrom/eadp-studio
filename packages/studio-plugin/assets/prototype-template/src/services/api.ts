import { request } from '@ead/suid-utils-react';
import { constants } from '@/utils';

const { SEI_AUTH_SERVER_PATH, SEI_BASIC_SERVER_PATH } = constants;

/** 登录 */
export async function login(params: any) {
  const url = `${SEI_AUTH_SERVER_PATH}/auth/login`;
  return request({
    url,
    method: 'POST',
    headers: {
      needToken: false,
    },
    data: params,
  });
}

/** 退出 */
export async function logout(params: any) {
  const url = `${SEI_AUTH_SERVER_PATH}/auth/logout`;
  return request({
    url,
    method: 'POST',
    headers: {
      needToken: false,
    },
    data: params,
  });
}

/** 获取当前用户有权限的功能项集合 */
export async function getAuthorizedFeatures(userId: string) {
  const url = `${SEI_BASIC_SERVER_PATH}/user/getUserAuthorizedFeatureMaps`;
  return request({
    url,
    params: { userId },
  });
}

/** 获取验证码 */
export async function getVerifyCode(reqId: string) {
  const url = `${SEI_AUTH_SERVER_PATH}/verifyCode/generate?reqId=${reqId}`;
  return request({
    url,
    headers: {
      needToken: false,
    },
  });
}
