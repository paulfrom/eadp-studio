import { setLocale, history as umiHistory } from 'umi';
import { qs, SEI_CONSTANTS, storage } from '@ead/suid-utils-react';
import { getAuthorizedFeatures, getVerifyCode, login } from '@/services/api';
import type { AnyAction, EffectsCommandMap, ReducersMapObject, SubscriptionAPI } from 'umi';

const { stringify } = qs;

const { CONST_GLOBAL } = SEI_CONSTANTS;

export default {
  namespace: 'global',
  state: {
    locationPathName: '/',
    locationQuery: {},
    showTenant: false,
    locale: 'zh-CN',
    verifyCode: '',
    showVertifCode: true,
  },
  subscriptions: {
    setupHistory({ dispatch, history }: SubscriptionAPI) {
      history.listen((his: any) => {
        dispatch({
          type: 'updateState',
          payload: {
            locationPathName: his.location.pathname,
            locationQuery: his.location.query,
          },
        });
      });
    },
  },
  effects: {
    *redirectLogin({}: AnyAction, { select }: EffectsCommandMap): any {
      const global = yield select((sel: any) => sel.global);
      const { locationPathName, locationQuery } = global;
      let location = locationPathName;
      if (location.indexOf('/user/login') !== -1) {
        location = locationQuery.from || '/';
      }
      umiHistory.replace({
        pathname: '/user/login',
        search: stringify({
          from: location,
        }),
      });
    },
    *getAuthorizedFeatures(
      { payload, callback = () => {} }: AnyAction,
      { call }: EffectsCommandMap,
    ): any {
      const res = yield call(getAuthorizedFeatures, payload);
      callback(res);
    },
    *login({ payload, callback = () => {} }: AnyAction, { call }: EffectsCommandMap): any {
      const res = yield call(login, payload);
      callback(res);
    },
    *getVerifyCode({ payload, callback = () => {} }: AnyAction, { call, put }: EffectsCommandMap): any {
      const result = yield call(getVerifyCode, payload.reqId);
      if (result?.success) {
        yield put({
          type: 'updateState',
          payload: {
            verifyCode: result.data,
          },
        });
      }
      callback(result);
    },
    *changeLocale({ payload }: AnyAction, { put }: EffectsCommandMap) {
      const { locale } = payload;
      storage.sessionStorage.set(CONST_GLOBAL.CURRENT_LOCALE, locale);
      yield put({
        type: 'updateState',
        payload: {
          locale,
        },
      });
      setLocale(locale, true);
      umiHistory.replace('/user/login');
    },
  },
  reducers: {
    updateState(state: any, { payload }: ReducersMapObject<any>) {
      return {
        ...state,
        ...payload,
      };
    },
  },
};
