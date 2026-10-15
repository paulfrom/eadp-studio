import { createRecords } from './fixtures';
import type { DemoRecord } from './fixtures';

export type DemoMode = 'normal' | 'empty' | 'error' | 'save-error';
let records = createRecords();
let mode: DemoMode = 'normal';

export function setDemoMode(next: DemoMode): void { mode = next; }
export function resetMockData(): void { records = createRecords(); mode = 'normal'; }

export const handlers: Record<string, (body?: unknown) => unknown> = {
  'POST /mock/reset': () => { resetMockData(); return records; },
  'GET /mock/records': () => {
    if (mode === 'error') throw new Error('合成请求错误，请切回正常场景重试');
    return mode === 'empty' ? [] : records;
  },
  'PUT /mock/record': (body) => {
    if (mode === 'save-error') throw new Error('合成保存失败，编辑内容已保留');
    const draft = body as Partial<DemoRecord>;
    if (!draft.id || !draft.name?.trim() || typeof draft.amount !== 'number' || draft.amount < 0) {
      throw new Error('名称必填，金额须为非负数');
    }
    const index = records.findIndex((record) => record.id === draft.id);
    if (index < 0) throw new Error('样例不存在');
    records[index] = { id: draft.id, name: draft.name.trim(), amount: draft.amount };
    return records[index];
  },
};
