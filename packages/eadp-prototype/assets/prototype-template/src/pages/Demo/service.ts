import { requestMock } from '@/mock/runtime';
import type { DemoRecord } from '@/mock/fixtures';

export const listRecords = () => requestMock<DemoRecord[]>('GET', '/mock/records');
export const saveRecord = (record: DemoRecord) => requestMock<DemoRecord>('PUT', '/mock/record', record);
export const resetRecords = () => requestMock<DemoRecord[]>('POST', '/mock/reset');
