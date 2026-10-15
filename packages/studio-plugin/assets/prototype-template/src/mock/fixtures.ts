export interface DemoRecord {
  id: string;
  name: string;
  amount: number;
}

export const createRecords = (): DemoRecord[] => [
  { id: 'demo-001', name: '合成样例 A', amount: 1280 },
  { id: 'demo-002', name: '合成样例 B', amount: 3600 },
];
