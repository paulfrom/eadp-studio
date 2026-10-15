import React from 'react';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { App, ConfigProvider } from '@ead/suid';
import zhCN from '@ead/suid/es/locale/zh_CN';
import { initializeMock } from '@/mock/runtime';

dayjs.locale('zh-cn');

export async function render(oldRender: () => void) {
  try {
    await initializeMock();
    oldRender();
  } catch (error) {
    const root = document.getElementById('eadp-prototype');
    if (root) {
      root.textContent = `演示初始化失败：${error instanceof Error ? error.message : '未知错误'}`;
      root.setAttribute('role', 'alert');
    }
  }
}

export function rootContainer(container: React.ReactNode) {
  return (
    <ConfigProvider locale={zhCN}>
      <App>{container}</App>
    </ConfigProvider>
  );
}
