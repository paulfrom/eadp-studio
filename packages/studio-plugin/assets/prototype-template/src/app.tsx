import React, { useEffect } from 'react';
import dayjs from 'dayjs';
import { ConfigProvider, theme, App } from '@ead/suid';
import { useUserContext } from '@ead/suid-utils-react';
import { constants } from '@/utils';

require('dayjs/locale/zh-cn');

const { LANG } = constants;

export function rootContainer(container: React.ReactNode) {
  const AppRoot = () => {
    const { currentLocale } = useUserContext();
    const { token } = theme.useToken();
    const microApp = (window as any)?.microApp;
    const globalData = microApp?.getGlobalData() as any;
    const primaryColor = globalData?.config?.themeInfo?.color || token.colorPrimary;

    const locale = LANG[currentLocale];
    useEffect(() => {
      if (currentLocale === 'zh-CN') {
        dayjs.locale('zh-cn');
      } else {
        dayjs.locale('en');
      }
    }, [currentLocale]);

    return (
      <ConfigProvider locale={locale} theme={{ token: { colorPrimary: primaryColor } }}>
        <App>{container}</App>
      </ConfigProvider>
    );
  };

  return <AppRoot />;
}
