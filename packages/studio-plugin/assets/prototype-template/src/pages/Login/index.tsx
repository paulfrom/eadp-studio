import React, { useEffect, useRef } from 'react';
import { connect, getIntl, history as umiHistory, useDispatch, useSelector } from 'umi';
import { createStyles } from '@ead/antd-style';
import type { InputRef } from '@ead/suid';
import { App, Button, Form, Input, Select } from '@ead/suid';
import type { ResponseResult } from '@ead/suid-utils-react';
import { getUUID, md5, useUserContext } from '@ead/suid-utils-react';
import { constants as localConstants } from '@/utils';
import { title } from '../../../package.json';

const FormItem = Form.Item;
const { Option } = Select;
const { formatMessage } = getIntl();
const { LOGIN_STATUS } = localConstants;

const useStyles = createStyles(({ prefixCls, token }) => {
  return {
    'login-form-box': {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      height: '100%',
      backgroundColor: token.colorBgContainer,
      ['.login-form']: {
        width: 320,
        height: 400,
        padding: token.padding,
        background: token.colorBgContainer,
        borderRadius: token.borderRadius,
        boxShadow: token.boxShadow,
        [`${prefixCls}-row.${prefixCls}.form-item`]: {
          height: 'auto',
          marginBlockEnd: token.margin,
        },
      },
      '.login-name': {
        padding: token.paddingSM,
        fontWeight: 700,
        fontSize: token.fontSizeLG,
        textAlign: 'center',
      },
    },
  };
});

const LoginForm = (props: any) => {
  const { loading } = props;
  const { message } = App.useApp();
  const { styles } = useStyles();
  const [form] = Form.useForm();
  const loginReqIdRef = useRef(getUUID());

  const userInputRef = useRef<InputRef>(null);

  const { locationQuery, showTenant, locale, verifyCode, showVertifCode } = useSelector(
    (sel: any) => sel.global,
  );
  const { setCurrentAuth, setCurrentUser, setSessionId, setCurrentPolicy } = useUserContext();

  const dispatch = useDispatch();

  const handleVertify = () => {
    dispatch({
      type: 'global/getVerifyCode',
      payload: {
        reqId: loginReqIdRef.current,
      },
      callback: (res: ResponseResult) => {
        if (!res?.success) {
          message.error(res?.message || '获取验证码失败');
        }
      },
    });
  };

  useEffect(() => {
    if (userInputRef.current) {
      userInputRef.current.focus();
      handleVertify();
    }
  }, []);

  const setAuthorizedFeatures = (userId: string) => {
    if (process.env.NODE_ENV !== 'production') {
      dispatch({
        type: 'global/getAuthorizedFeatures',
        payload: userId,
        callback: (res: ResponseResult) => {
          if (res.success) {
            setCurrentAuth(res.data);
          } else {
            message.error('获取权限失败');
          }
        },
      });
    }
  };

  const setRequireTenant = (payload: any) => {
    dispatch({
      type: 'global/updateState',
      payload,
    });
  };

  const handlerSubmit = (formData: any) => {
    const user = { ...formData };
    user.password = md5(user.password);
    user.reqId = loginReqIdRef.current;
    dispatch({
      type: 'global/login',
      payload: {
        ...user,
      },
      callback: (res: ResponseResult) => {
        const msg = res.message;
        if (res.success) {
          const { loginStatus, authorityPolicy, sessionId, userId } = res.data || {};
          const { from } = locationQuery;
          switch (loginStatus) {
            case LOGIN_STATUS.SUCCESS:
              message.success('登录成功');
              setCurrentUser(res.data);
              setSessionId(sessionId);
              setCurrentPolicy(authorityPolicy);
              setAuthorizedFeatures(userId);
              if (from && from.indexOf('/user/login') === -1) {
                if (from === '/') {
                  umiHistory.push('/dashboard');
                } else {
                  umiHistory.push(from);
                }
              } else {
                umiHistory.push('/');
              }
              break;
            case LOGIN_STATUS.MULTI_TENANT:
              message.warning('需要输入租户账号');
              setRequireTenant({
                showTenant: true,
              });
              break;
            case LOGIN_STATUS.CAPTCHA_ERROR:
              message.error(msg || '验证码错误');
              setRequireTenant({
                showVertifCode: true,
              });
              break;
            case LOGIN_STATUS.FROZEN:
              message.error('账号被冻结');
              break;
            case LOGIN_STATUS.LOCKED:
              message.error('账号被锁定');
              break;
            case LOGIN_STATUS.FAILURE:
              message.error('账号或密码错误');
              break;
            default:
              message.error(msg || '登录失败');
          }
        } else {
          message.error(msg || '登录失败');
        }
      },
    });
  };

  const handlerLocaleChange = (locale: string) => {
    dispatch({
      type: 'global/changeLocale',
      payload: {
        locale,
      },
    });
  };

  return (
    <div className={styles['login-form-box']}>
      <div className="login-form">
        <div className="login-logo">
          <div className="login-name">{`${title}-用户登录`}</div>
        </div>
        <Form
          form={form}
          initialValues={{ locale, password: 'EadpAdmin@2026!@#' }}
          style={{ maxWidth: '300px' }}
          onFinish={handlerSubmit}
        >
          {showTenant && (
            <FormItem name="tenant" rules={[{ required: true, message: '请输入租户账号' }]}>
              <Input autoFocus size="large" placeholder="租户账号" />
            </FormItem>
          )}
          <FormItem name="account" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input
              ref={userInputRef}
              size="large"
              placeholder={formatMessage({
                id: 'login.account',
                defaultMessage: '用户名',
              })}
            />
          </FormItem>
          <FormItem name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input
              size="large"
              type="password"
              placeholder={formatMessage({
                id: 'login.password',
                defaultMessage: '密码',
              })}
            />
          </FormItem>
          {showVertifCode && verifyCode ? (
            <FormItem name="verifyCode" rules={[{ required: true, message: '请输入验证码' }]}>
              <Input
                size="large"
                disabled={loading.global}
                placeholder={formatMessage({
                  id: 'login.verifyCode',
                  defaultMessage: '验证码',
                })}
                addonAfter={<img alt="验证码" onClick={handleVertify} src={verifyCode} />}
              />
            </FormItem>
          ) : null}
          <FormItem name="locale" rules={[{ required: true, message: '请选择语言' }]}>
            <Select size="large" onChange={handlerLocaleChange}>
              <Option value="zh-CN">简体中文</Option>
              <Option value="en-US">English</Option>
            </Select>
          </FormItem>
          <FormItem label={null}>
            <Button
              type="primary"
              htmlType="submit"
              size="large"
              className="login-form-button"
              block
              disabled={loading.effects['global/getVerifyCode']}
              loading={loading.effects['global/login']}
            >
              登录
            </Button>
          </FormItem>
        </Form>
      </div>
    </div>
  );
};

const ConnectedLoginForm: any = connect(({ global, loading }) => ({
  global,
  loading,
}))(LoginForm);

export default ConnectedLoginForm;
