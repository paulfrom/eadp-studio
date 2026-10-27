'use strict';

// This file is a local interaction model. No network, model or engineering command is executed.
(() => {
  const $ = (id) => document.getElementById(id);
  const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const paths = {
    flow: 'M4 4h6v6H4z M14 14h6v6h-6z M7 10v7h7 M14 4h6v6h-6z M10 7h4',
    document: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
    layout: 'M3 4h18v16H3z M3 9h18 M9 9v11', layers: 'm12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5',
    handoff: 'M4 4h9v16H4z M9 12h12 m-4-4 4 4-4 4', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
    link: 'm10 13 4-4 M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
    spark: 'm12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z',
    'panel-left': 'M3 4h18v16H3z M9 4v16 m6-11-3 3 3 3', files: 'M8 3h10v14H8z M5 7H3v14h11v-2',
    'chevron-right': 'm9 5 7 7-7 7', 'chevron-down': 'm5 9 7 7 7-7', 'chevron-up': 'm5 15 7-7 7 7',
    'arrow-up': 'M12 20V4 m-6 6 6-6 6 6', 'arrow-right': 'M4 12h16 m-6-6 6 6-6 6',
    check: 'm5 12 4 4L19 6', 'check-circle': 'M21 11v1a9 9 0 1 1-5.3-8.2 M8 11l4 4 9-10',
    square: 'M6 6h12v12H6z', play: 'm8 4 12 8-12 8z', eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12 M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    code: 'm8 5-7 7 7 7 M16 5l7 7-7 7 m-2-17-4 20', more: 'M5 11h.01 M12 11h.01 M19 11h.01 M5 12h.01 M12 12h.01 M19 12h.01',
    refresh: 'M20 7a9 9 0 1 0 1 8 M20 2v6h-6', diff: 'M4 3h7v18H4z M14 3h6v18h-6 M6 8h3 M16 8h2 M7.5 6.5v3 M16 15h2 M6 15h3',
    sliders: 'M4 5h16 M4 12h16 M4 19h16 M8 2v6 M16 9v6 M10 16v6', globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3a17 17 0 0 0 0 18 17 17 0 0 0 0-18',
    monitor: 'M3 4h18v13H3z M8 21h8 M12 17v4', tablet: 'M5 2h14v20H5z M11 19h2', phone: 'M7 2h10v20H7z M11 19h2',
    maximize: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5', external: 'M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7',
    shield: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z m-4 10 3 3 5-6', clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 6v6l4 2',
    folder: 'M3 5h6l2 3h10v12H3z', lock: 'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4', edit: 'm15 3 6 6-12 12H3v-6z M12 6l6 6',
    search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 m-2 5 6 6', terminal: 'm4 6 5 6-5 6 M12 18h8', alert: 'm12 3 10 18H2z M12 9v5 M12 17v1',
    close: 'm6 6 12 12 M6 18 18 6', plus: 'M12 4v16 M4 12h16', package: 'm12 3 9 5v10l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v10 M7 5l10 5',
  };
  function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.document}"/></svg>`; }
  function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon); }); }
  const files = {
    page: { name: 'index.tsx', path: '原型代码/src/pages/PurchaseOrders/index.tsx', type: 'TypeScript React', editable: true, text: `import { useEffect, useMemo, useState } from 'react';
import { Button, Money, MoneyInput } from '@ead/suid';
import type { PurchaseOrder } from '@/mock/fixtures';
import { getOrders, saveOrder } from './service';
import styles from './index.less';

// 采购订单页面的缩略示意：本地 Mock、筛选与草稿金额编辑。
export default function PurchaseOrders() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState('all');
  const [editingOrder, setEditingOrder] = useState<PurchaseOrder>();
  useEffect(() => { void getOrders().then(setOrders); }, []);
  const visibleOrders = useMemo(() => orders.filter((order) => {
    const matchText = order.supplier.includes(keyword)
      || order.number.includes(keyword);
    return matchText && (status === 'all' || order.status === status);
  }), [orders, keyword, status]);

  async function handleSave() {
    if (!editingOrder) return;
    if (!Number.isInteger(editingOrder.quantity) || editingOrder.quantity < 1) {
      throw new Error('数量须为大于 0 的整数');
    }
    const amount = editingOrder.quantity * editingOrder.unitPrice;
    const savedOrder = await saveOrder({ ...editingOrder, amount });
    setOrders((current) => [savedOrder, ...current.filter(
      (order) => order.id !== savedOrder.id,
    )]);
    setEditingOrder(undefined);
  }

  return (
    <section className={styles.page}>
      <header className={styles.heading}>
        <h1>采购订单</h1>
      </header>
      <ul>{visibleOrders.map((order) => (
        <li key={order.id}>
          {order.number} · {order.supplier}<Money value={order.amount} />
          <Button disabled={order.status !== 'draft'}
            onClick={() => setEditingOrder({ ...order })}>编辑草稿</Button>
        </li>
      ))}</ul>
      {editingOrder && <section aria-label="编辑草稿">
        <label>单价<MoneyInput value={editingOrder.unitPrice} precision={2}
          precisionType="round" onChange={(price) => setEditingOrder({
            ...editingOrder, unitPrice: Number(price ?? 0),
          })} /></label>
        <Button onClick={() => { void handleSave(); }}>保存</Button>
        <Button onClick={() => setEditingOrder(undefined)}>取消</Button>
      </section>}
    </section>
  );
}` },
    style: { name: 'index.less', path: '原型代码/src/pages/PurchaseOrders/index.less', type: 'Less', editable: true, text: `.page {
  min-height: 100%;
  padding: 28px;
  background: #f6f8fb;
}

.heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;

  h1 {
    margin: 0;
    color: #202b41;
    font-size: 23px;
    font-weight: 600;
  }
}

.amount {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}` },
    service: { name: 'service.ts', path: '原型代码/src/pages/PurchaseOrders/service.ts', type: 'TypeScript', editable: true, text: `import { requestMock } from '@/mock/runtime';
import type { PurchaseOrder } from '@/mock/fixtures';

// 只调度本地合成数据处理器，不创建网络请求。
export function getOrders() {
  return requestMock<PurchaseOrder[]>('GET', '/mock/orders');
}

export function saveOrder(order: PurchaseOrder) {
  return requestMock<PurchaseOrder>('PUT', '/mock/order', order);
}` },
    fixtures: { name: 'fixtures.ts', path: '原型代码/src/mock/fixtures.ts', type: 'TypeScript', editable: true, text: `// 页面演示专用合成数据，不包含真实采购信息。
export interface PurchaseOrder {
  id: string; number: string; supplier: string; product: string;
  quantity: number; unitPrice: number; amount: number;
  status: 'pending' | 'approved' | 'draft'; date: string;
}

export const orders: PurchaseOrder[] = [
  { id: '1', number: 'PO-20261026-001', supplier: '华东办公用品',
    product: '人体工学办公椅', quantity: 20, unitPrice: 680,
    amount: 13600, status: 'pending', date: '2026-10-26' },
  { id: '2', number: 'PO-20261025-008', supplier: '启明电子科技',
    product: '27 英寸显示器', quantity: 12, unitPrice: 1899,
    amount: 22788, status: 'approved', date: '2026-10-25' },
  { id: '3', number: 'PO-20261025-006', supplier: '远山工业设备',
    product: '仓储标签打印机', quantity: 3, unitPrice: 2450,
    amount: 7350, status: 'draft', date: '2026-10-25' },
];

export const suppliers = [
  { id: 'S001', name: '华东办公用品', category: '办公家具', contact: '沈佳' },
  { id: 'S002', name: '启明电子科技', category: '电子设备', contact: '顾晨' },
];
export const approvals = [
  { id: 'A001', orderNumber: 'PO-20261026-001', node: '部门审批',
    operator: '陈明', result: '处理中' },
];` },
    handlers: { name: 'handlers.ts', path: '原型代码/src/mock/handlers.ts', type: 'TypeScript', editable: false, text: `import { orders as initialOrders, approvals, suppliers } from './fixtures';
import type { PurchaseOrder } from './fixtures';
let orders = [...initialOrders];

// 此样例展示 Mock 行为，本任务未授权编辑初始化处理器。
export const handlers: Record<string, (body?: unknown) => unknown> = {
  'GET /mock/orders': () => orders,
  'GET /mock/approvals': () => approvals,
  'GET /mock/suppliers': () => suppliers,
  'PUT /mock/order': (body) => {
    const order = body as PurchaseOrder;
    if (!order.supplier?.trim() || !Number.isInteger(order.quantity)
      || order.quantity < 1 || order.unitPrice <= 0) {
      throw new Error('订单必填项、数量或单价不符合规则');
    }
    const saved = { ...order, amount: order.quantity * order.unitPrice };
    orders = orders.map((item) => item.id === saved.id ? saved : item);
    return saved;
  },
};` },
    routes: { name: 'routes.json', path: '原型代码/config/routes.json', type: 'JSON', editable: false, text: `[
  {
    "path": "/purchase-orders",
    "name": "采购订单",
    "component": "@/pages/PurchaseOrders"
  },
  {
    "path": "/approval-records",
    "name": "审批记录",
    "component": "@/pages/ApprovalRecords"
  },
  {
    "path": "/suppliers",
    "name": "供应商目录",
    "component": "@/pages/Suppliers"
  }
]` },
    approvals: { name: 'index.tsx', path: '原型代码/src/pages/ApprovalRecords/index.tsx', type: 'TypeScript React', editable: true, text: `import { useEffect, useState } from 'react';
import { Button } from '@ead/suid';
import { requestMock } from '@/mock/runtime';

// 审批记录页面的缩略示意：追溯订单的处理过程。
export default function ApprovalRecords() {
  type Record = { id: string; orderNumber: string; node: string;
    operator: string; result: string };
  const [records, setRecords] = useState<Record[]>([]);
  useEffect(() => {
    void requestMock<Record[]>('GET', '/mock/approvals').then(setRecords);
  }, []);
  return <section><h1>审批记录</h1>
    {records.map((record) => <article key={record.id}>
      <strong>{record.orderNumber}</strong>
      <span>{record.node} · {record.operator} · {record.result}</span>
      <Button>查看过程</Button>
    </article>)}
  </section>;
}` },
    suppliers: { name: 'index.tsx', path: '原型代码/src/pages/Suppliers/index.tsx', type: 'TypeScript React', editable: true, text: `import { useEffect, useState } from 'react';
import { Input } from '@ead/suid';
import { requestMock } from '@/mock/runtime';

// 供应商目录页面的缩略示意：按名称检索可用供应商。
export default function Suppliers() {
  type Supplier = { id: string; name: string; category: string };
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [keyword, setKeyword] = useState('');
  useEffect(() => {
    void requestMock<Supplier[]>('GET', '/mock/suppliers').then(setSuppliers);
  }, []);
  return <section><h1>供应商目录</h1>
    <Input value={keyword} placeholder="搜索供应商"
      onChange={(event) => setKeyword(event.target.value)} />
    <ul>{suppliers.filter((item) => item.name.includes(keyword))
      .map((item) => <li key={item.id}>{item.name} · {item.category}</li>)}
    </ul>
  </section>;
}` },
  };
  Object.values(files).forEach((file) => { file.original = file.text; file.tabLabel = file.name === 'index.tsx' ? file.path.split('/').slice(-2).join('/') : file.name; });
  const state = {
    mode: 'preview', runtime: 'running', revision: 1, previewRevision: 1,
    checkRevision: 1, checks: 'passed', checkItems: ['passed', 'passed', 'passed', 'passed', 'passed'],
    route: 'orders', device: 'desktop', aiCollapsed: window.innerWidth <= 1100, treeCollapsed: window.innerWidth <= 800,
    openFiles: ['page', 'style'], activeFile: 'page', editing: false, draft: '',
    drawer: null, output: null, pendingAction: null,
    failNextRun: false, failChecks: false, failSave: false, emptyPreview: false,
    submitted: false, submitting: false, review: ['unreviewed', 'unreviewed', 'unreviewed', 'unreviewed'],
    issues: ['', '', '', ''], searchMatches: [], searchIndex: 0, logs: [
      ['10:25:02', 'ready', '模拟项目原型已载入：订单、审批与供应商'],
      ['10:25:03', 'ready', 'Mock 合成数据就绪，业务预览已运行'],
      ['10:25:05', 'ready', '工程检查通过：typecheck / lint / build / mock / browser'],
    ],
  };
  // Each simulated item owns a separate in-memory scene; page reload deliberately resets it.
  const initialScene = structuredClone(state);
  const initialFiles = Object.fromEntries(Object.entries(files).map(([id, file]) => [id, file.text]));
  const items = [
    { id: 'DEMO-01', title: '订单体验完善', phase: '待用户核对', claims: ['REQ-0012'], firstInstruction: '', sent: true, scene: null },
    { id: 'DEMO-02', title: '供应商查询优化', phase: '待开始', claims: ['REQ-0014'], firstInstruction: '实现供应商类别筛选，并保留无匹配结果的提示。', sent: false, scene: null },
  ];
  let selectedItem = items[0], nextItem = 3;
  let externalApprovalOccupied = true;
  let taskNotice = '';
  let expansionFailed = false;
  function saveScene() {
    selectedItem.scene = { state: structuredClone({ ...state, drawer: null, pendingAction: null }),
      files: Object.fromEntries(Object.entries(files).map(([id, file]) => [id, file.text])),
      chat: $('chat-scroll').innerHTML, input: $('chat-input').value };
  }
  function switchItem(id) {
    const item = items.find((entry) => entry.id === id); if (!item || item === selectedItem) return;
    guardUnsaved(() => {
      saveScene(); ++runtimeToken; ++checkToken;
      selectedItem = item;
      const scene = item.scene;
      Object.keys(state).forEach((key) => { delete state[key]; });
      Object.assign(state, structuredClone(scene?.state || { ...initialScene, runtime: 'stopped', checks: 'stale', checkRevision: 0, previewRevision: 0 }));
      Object.entries(scene?.files || initialFiles).forEach(([key, text]) => { files[key].text = text; });
      $('chat-scroll').innerHTML = scene?.chat || '<div class="conversation-end">此事项尚未发送首次实现指令 · 模拟现场</div>';
      $('chat-input').value = scene?.input || '';
      taskNotice = ''; expansionFailed = false;
      closeDrawer(); renderChrome(); renderEditor(); mountPreview();
      toast('已切换独立模拟现场；未启动模型或发送指令。');
    });
  }
  function renderItemContext() {
    $('task-label').textContent = `${selectedItem.title} · ${selectedItem.phase}`;
    $('task-context').textContent = `模拟现场 · 开发 ${selectedItem.claims.join('、')} · 源码 r${state.revision} / 预览 r${state.previewRevision}`;
    document.querySelector('.session-line').innerHTML = `<span class="status-dot"></span>模拟会话 · ${selectedItem.id}<span>${selectedItem.phase}</span>`;
  }
  function renderItems() {
    const running = items.find((item) => item.phase === '正在执行');
    $('drawer-body').innerHTML = `<div class="drawer-notice">事项、领取与队列均为本页内存模拟；刷新整页重置。切换只查看现场，继续才模拟执行；暂停不释放开发占用。</div>
      <section class="drawer-section"><h3 style="margin-top:20px">我的事项与队列</h3><div class="item-list">${items.map((item, index) => `<article class="item-row ${item === selectedItem ? 'selected' : ''}"><div><strong>${index + 1}. ${escapeHTML(item.title)}</strong><span class="tag">${item.phase}</span></div><p>${item.claims.join('、')} · ${item.sent ? '首次指令已发送（模拟）' : '首次指令已排队，尚未发送'}</p>${!item.sent ? `<p>已保存指令：${escapeHTML(item.firstInstruction)}</p>` : ''}<button class="subtle-button" data-action="item-switch" data-value="${item.id}" ${item === selectedItem ? 'disabled' : ''}>${item === selectedItem ? '当前现场' : '查看现场'}</button></article>`).join('')}</div></section>
      <section class="drawer-section"><h3>当前事项</h3><p>${escapeHTML(selectedItem.title)} · ${selectedItem.phase}</p><div class="collection-actions"><button class="primary-button" data-action="item-continue" ${selectedItem.phase === '正在执行' ? 'disabled' : ''}>${selectedItem.sent ? '继续当前事项' : '发送已排队实现指令'}</button><button class="subtle-button" data-action="item-pause" ${selectedItem.phase !== '正在执行' ? 'disabled' : ''}>暂停</button></div><p>${running ? `当前执行：${escapeHTML(running.title)}。切换现场不会自动切换执行项。` : '当前没有执行中的事项，队列不会自动开始。'}</p></section>
      <section class="drawer-section"><h3>准备另一个事项</h3><label for="queue-instruction">首次实现指令</label><textarea id="queue-instruction" class="item-instruction" rows="3" placeholder="明确说明希望实现的内容"></textarea><label for="queue-requirement">实际开发需求（模拟样本）</label><select id="queue-requirement" class="diff-file-select"><option value="REQ-0013">REQ-0013 审批记录 · 陈明开发中</option><option value="REQ-0014">REQ-0014 供应商目录 · 本人事项已占用</option></select><button class="subtle-button" data-action="item-enqueue">发送实现指令并尝试入队（模拟）</button><button class="text-button" data-action="item-enqueue-retry">演示陈明释放后重试入队</button><p>有执行事项时入队等待，否则首次发送直接模拟执行。失败保留指令，不创建可写事项；查看需求和普通讨论不领取开发权。</p></section>
      <section class="drawer-section"><h3>扩展当前开发范围</h3><p>尝试扩领审批记录：先模拟占用冲突，再可切换到对方已释放的恢复样本。原占用和现场始终保留，不发送实现消息。</p><button class="subtle-button" data-action="item-expand">尝试扩领 REQ-0013（模拟）</button>${expansionFailed ? '<button class="text-button" data-action="item-expand-retry">演示对方释放后重试</button>' : ''}</section><div id="item-notice" class="drawer-notice warning" role="status" ${taskNotice ? '' : 'hidden'}>${escapeHTML(taskNotice)}</div>`;
  }
  function continueItem() {
    const running = items.find((item) => item.phase === '正在执行' && item !== selectedItem);
    if (running) { taskNotice = `请先暂停「${running.title}」再继续；已排队指令仍保留，未发送。`; renderItems(); return; }
    if (!selectedItem.sent) {
      const message = document.createElement('article'); message.className = 'message user-message';
      message.innerHTML = `<div class="message-author">你 · 排队实现指令（模拟发送）</div><p>${escapeHTML(selectedItem.firstInstruction)}</p>`;
      $('chat-scroll').append(message); selectedItem.sent = true;
    }
    selectedItem.phase = '正在执行'; taskNotice = '正在执行仅为交互状态，无模型请求或代码写入；可暂停，其他事项不会自动开始。';
    renderChrome(); renderItems();
  }
  function enqueueItem() {
    const input = $('queue-instruction'); const instruction = input.value.trim();
    if (!instruction) { input.focus(); taskNotice = '请先填写明确的首次实现指令。'; $('item-notice').hidden = false; $('item-notice').textContent = taskNotice; return; }
    const requirement = $('queue-requirement').value;
    const existing = items.find((item) => item.claims.includes(requirement));
    if (existing || (requirement === 'REQ-0013' && externalApprovalOccupied)) {
      const owner = existing ? `林晓 · ${existing.title}` : '陈明 · 审批流程优化';
      taskNotice = `${requirement} 已由 ${owner} 开发（模拟）。未创建事项，未发送指令；输入已保留，可继续查看参考材料。`;
      $('item-notice').hidden = false; $('item-notice').textContent = taskNotice; return;
    }
    guardUnsaved(() => {
      const item = { id: `DEMO-${String(nextItem++).padStart(2, '0')}`, title: '审批体验调整', phase: '待开始', claims: [requirement], firstInstruction: instruction, sent: false, scene: null };
      items.push(item);
      if (items.some((entry) => entry.phase === '正在执行')) {
        taskNotice = '已领取并入队（模拟），首次指令保留、尚未发送；当前事项继续执行。'; renderChrome(); renderItems();
      } else {
        switchItem(item.id); continueItem(); openDrawer('tasks');
        taskNotice = '首次发送已直接开始模拟执行；没有额外的继续步骤，没有真实模型请求。'; renderItems();
      }
    });
  }
  const checkNames = ['typecheck', 'lint', 'build', 'mock', 'browser'];
  const checkDetails = ['类型检查', '代码规范', '原型构建', 'Mock 数据与请求', '页面启动与路由'];
  const reviewTexts = ['采购订单：搜索、状态筛选与空态符合使用习惯，金额计算与草稿编辑规则清晰。', '审批记录：订单编号、处理节点、人员与意见能够相互追溯。', '供应商目录：名称、采购类别、联系人与可用状态便于查阅。', '跨需求体验：订单、审批与供应商页面导航一致，异常反馈和恢复操作连贯。'];
  let toastTimer, runtimeToken = 0, checkToken = 0, lastFocus = null;
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200); }
  function addLog(message, kind = 'ready') { state.logs.push([new Date().toLocaleTimeString('zh-CN', { hour12: false }), kind, message]); if (state.output === 'runtime') renderOutput(); }
  function canConfirm() { return !state.editing && state.checks === 'passed' && state.checkRevision === state.revision; }
  function renderChrome() {
    renderItemContext();
    $('preview-pane').hidden = state.mode !== 'preview'; $('code-pane').hidden = state.mode !== 'code';
    ['preview', 'code'].forEach((mode) => { $(mode + '-tab').setAttribute('aria-selected', String(state.mode === mode)); $(mode + '-tab').tabIndex = state.mode === mode ? 0 : -1; });
    $('ai-panel').hidden = state.aiCollapsed; $('show-ai').hidden = !state.aiCollapsed;
    $('file-tree').hidden = state.treeCollapsed; $('show-tree').hidden = !state.treeCollapsed;
    $('workspace-body').classList.toggle('ai-expanded', window.innerWidth <= 1100 && !state.aiCollapsed);
    $('code-pane').classList.toggle('tree-expanded', window.innerWidth <= 800 && !state.treeCollapsed);
    document.querySelector('.context-chip').innerHTML = `${icon('files')}需求集合 · 3 项${icon('chevron-right')}`;
    $('stale-preview').hidden = state.previewRevision === state.revision || state.runtime !== 'running';
    $('run-button').innerHTML = icon(state.runtime === 'running' ? 'square' : 'play') + (state.runtime === 'running' ? '停止' : state.runtime === 'starting' ? '启动中' : '运行预览');
    $('run-button').disabled = state.runtime === 'starting';
    const checkLabel = state.checks === 'running' ? '检查中' : '工程检查';
    $('check-button').innerHTML = icon('check-circle') + `<span>${checkLabel}</span><i class="tiny-dot ${state.checks === 'passed' && state.checkRevision === state.revision ? 'good' : state.checks === 'failed' ? 'bad' : 'warn'}"></i>`;
    $('check-button').disabled = state.checks === 'running';
    const checkSummary = state.checks === 'running' ? '正在检查…' : state.checks === 'failed' ? '工程检查失败' : state.checkRevision !== state.revision ? '源码已更改 · 待检查' : '工程检查通过';
    $('output-summary').innerHTML = `<i class="tiny-dot ${state.checks === 'passed' && state.checkRevision === state.revision ? 'good' : state.checks === 'failed' ? 'bad' : 'warn'}"></i>${checkSummary}`;
    $('checks-count').textContent = state.checks === 'running' ? '…' : state.checkRevision !== state.revision ? '待检查' : `${state.checkItems.filter((item) => item === 'passed').length}/5`;
    $('problem-count').textContent = String((state.checks === 'failed' ? 1 : 0) + (state.runtime === 'failed' ? 1 : 0));
    $('workspace-status').textContent = state.editing ? '正在编辑样例源码 · 尚未保存' : state.submitted ? '模拟基线已形成' : '当前源码已保存';
    const runtimeNames = { running: '预览运行中', stopped: '预览已停止', starting: '正在启动', failed: '预览启动失败' };
    $('runtime-pill').className = 'runtime-pill ' + state.runtime;
    $('runtime-pill').innerHTML = '<i></i>' + runtimeNames[state.runtime];
    $('route-select').value = state.route;
    $('preview-frame-wrap').dataset.device = state.device;
    $('preview-size').textContent = { desktop: '自适应桌面', tablet: '平板 · 768 px', mobile: '手机 · 390 px' }[state.device];
    document.querySelectorAll('[data-action="device"]').forEach((node) => { const selected = node.dataset.value === state.device; node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected)); });
    renderRuntime(); hydrateIcons();
  }
  function renderRuntime() {
    const placeholder = $('runtime-placeholder'); placeholder.hidden = state.runtime === 'running';
    $('preview-frame-wrap').hidden = state.runtime !== 'running';
    if (state.runtime === 'running') return;
    const content = state.runtime === 'failed' ? ['alert', '预览未能启动', '模拟故障：构建进程未就绪。已有代码和业务输入均保留，可以重新运行。', '重试启动'] : state.runtime === 'starting' ? ['refresh', '正在准备预览', '正在模拟启动本地页面和 Mock 数据…', null] : ['monitor', '预览已停止', '实现仍保留在代码中。运行预览后，即可继续核对页面和业务流程。', '运行预览'];
    placeholder.innerHTML = `<div class="state-art ${state.runtime === 'starting' ? 'spinning' : ''}">${icon(content[0])}</div><h3>${content[1]}</h3><p>${content[2]}</p>${content[3] ? `<button class="primary-button" data-action="restart">${icon('play')}${content[3]}</button>` : ''}`;
  }
  function setMode(mode) { state.mode = mode; renderChrome(); if (mode === 'code') renderEditor(); }
  function guardUnsaved(callback) { if (state.editing && $('source-editor').value !== files[state.activeFile].text) { state.pendingAction = callback; $('unsaved-dialog').showModal(); return; } if (state.editing) cancelEdit(); callback(); }
  function openFile(id) { guardUnsaved(() => { state.activeFile = id; if (!state.openFiles.includes(id)) state.openFiles.push(id); state.mode = 'code'; renderChrome(); renderEditor(); }); }
  function closeFile(id) { const close = () => { state.openFiles = state.openFiles.filter((key) => key !== id); if (state.activeFile === id) state.activeFile = state.openFiles.at(-1) || null; renderEditor(); }; if (id === state.activeFile) guardUnsaved(close); else close(); }
  function highlight(line) {
    const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*$|\b(?:import|from|export|default|function|return|const|let|if|throw|new|async|await|true|false|null)\b|\b\d+(?:\.\d+)?\b)/g;
    let output = '', previous = 0;
    for (const match of line.matchAll(tokens)) { output += escapeHTML(line.slice(previous, match.index)); const value = match[0]; const kind = value.startsWith('//') ? 'comment' : /^['"]/.test(value) ? 'string' : /^\d/.test(value) ? 'number' : 'keyword'; output += `<span class="syntax-${kind}">${escapeHTML(value)}</span>`; previous = match.index + value.length; }
    return output + escapeHTML(line.slice(previous));
  }
  function renderEditor() {
    $('file-tabs').innerHTML = state.openFiles.map((id) => `<div class="file-tab ${state.activeFile === id ? 'active' : ''}"><button role="tab" aria-selected="${state.activeFile === id}" data-action="open-file" data-value="${id}">${escapeHTML(files[id].tabLabel)}${state.editing && state.activeFile === id ? ' •' : ''}</button><button class="tab-close" data-action="close-file" data-value="${id}" aria-label="关闭 ${escapeHTML(files[id].tabLabel)}">${icon('close')}</button></div>`).join('');
    document.querySelectorAll('.tree-file').forEach((node) => node.classList.toggle('active', node.dataset.value === state.activeFile));
    const file = files[state.activeFile];
    if (!file) { $('file-breadcrumb').textContent = '没有打开的文件'; $('highlighted-code').innerHTML = '<span class="no-open-file">从文件树选择一个文件<button class="subtle-button" data-action="open-file" data-value="page">打开订单页面源码</button></span>'; $('source-editor').hidden = true; $('highlighted-code').hidden = false; ['edit-file', 'save-file', 'cancel-edit', 'readonly-label'].forEach((id) => $(id).hidden = true); $('file-status').textContent = '未选择文件'; return; }
    $('file-breadcrumb').textContent = file.path; $('file-status').textContent = file.type;
    $('readonly-label').hidden = false; $('readonly-label').textContent = state.editing ? '编辑中' : file.editable ? '只读预览' : '本任务未授权编辑';
    $('edit-file').hidden = state.editing; $('edit-file').disabled = !file.editable;
    $('edit-file').title = file.editable ? '编辑授权样例文件' : '本任务未授权编辑此样例文件';
    $('save-file').hidden = !state.editing; $('cancel-edit').hidden = !state.editing;
    $('source-editor').hidden = !state.editing; $('highlighted-code').hidden = state.editing;
    if (state.editing) $('source-editor').value = state.draft;
    else renderSource();
  }
  function renderSource() { const file = files[state.activeFile]; if (!file) return; $('highlighted-code').innerHTML = file.text.split('\n').map((line, index) => `<span class="code-line" data-line="${index + 1}"><span class="line-number" aria-hidden="true">${index + 1}</span>${highlight(line) || ' '}</span>`).join(''); searchCode(false); }
  function beginEdit() { const file = files[state.activeFile]; if (!file || !file.editable) return; state.editing = true; state.draft = file.text; renderEditor(); renderChrome(); $('source-editor').focus(); }
  function cancelEdit() { state.editing = false; state.draft = ''; renderEditor(); renderChrome(); }
  function saveEdit() {
    const file = files[state.activeFile]; if (!state.editing || !file?.editable) return;
    const changed = file.text !== $('source-editor').value;
    file.text = $('source-editor').value; state.editing = false; state.draft = '';
    if (changed) { state.revision++; state.submitted = false; state.checks = 'stale'; addLog(`样例源码已保存：${file.path}。检查与预览待更新。`); toast('样例已保存。请重新检查并运行预览；业务预览使用独立演示数据。'); }
    renderEditor(); renderChrome(); if (state.output) renderOutput();
  }
  function searchCode(advance) {
    const query = $('code-search').value.toLowerCase(); const file = files[state.activeFile];
    state.searchMatches = file && query ? file.text.split('\n').flatMap((line, index) => line.toLowerCase().includes(query) ? [index + 1] : []) : [];
    state.searchIndex = advance && state.searchMatches.length ? (state.searchIndex + 1) % state.searchMatches.length : 0;
    document.querySelectorAll('.code-line.match').forEach((node) => node.classList.remove('match'));
    const line = state.searchMatches[state.searchIndex]; const target = $('highlighted-code').querySelector(`[data-line="${line}"]`);
    if (target) { target.classList.add('match'); target.scrollIntoView({ block: 'center' }); }
    $('search-result').textContent = query ? state.searchMatches.length ? `${state.searchIndex + 1} / ${state.searchMatches.length} 行` : '无结果' : '';
  }

  function runPreview() {
    if (state.editing) { toast('请先保存或取消当前源码编辑。'); return; }
    const token = ++runtimeToken;
    state.runtime = 'starting'; state.submitted = false; renderChrome(); addLog('正在模拟启动预览…');
    setTimeout(() => {
      if (token !== runtimeToken) return;
      if (state.failNextRun) { state.failNextRun = false; state.runtime = 'failed'; addLog('模拟构建进程未就绪，可重试启动。', 'error'); }
      else { state.runtime = 'running'; state.previewRevision = state.revision; mountPreview(); addLog('预览已就绪；此为固定业务演示，样例编辑不会执行代码。'); }
      renderChrome(); if (state.drawer === 'confirm') renderConfirm();
    }, 850);
  }
  function toggleRun() { if (state.runtime === 'running') { ++runtimeToken; state.runtime = 'stopped'; renderChrome(); addLog('预览已停止。'); } else runPreview(); }
  function runChecks() {
    if (state.editing) { toast('请先保存或取消源码编辑。'); return; }
    if (state.checks === 'running') return;
    const token = ++checkToken, checkedRevision = state.revision;
    state.checks = 'running'; state.checkItems = Array(5).fill('pending'); state.submitted = false; state.output = 'checks'; renderChrome(); renderOutput();
    addLog('开始模拟工程检查；不会在本机执行命令。');
    checkNames.forEach((name, index) => setTimeout(() => {
      if (token !== checkToken) return;
      state.checkItems[index] = state.failChecks && index === 2 ? 'failed' : 'passed';
      if (index === 4) { state.checkRevision = checkedRevision; state.checks = state.checkItems.includes('failed') ? 'failed' : checkedRevision === state.revision ? 'passed' : 'stale'; addLog(state.checks === 'passed' ? '模拟工程检查 5/5 通过。' : state.checks === 'failed' ? '模拟 build 检查失败，请修正后重试。' : '检查期间源码变更，结果已过期。', state.checks === 'failed' ? 'error' : 'ready'); }
      renderChrome(); renderOutput(); if (state.drawer === 'confirm') renderConfirm();
    }, 240 * (index + 1)));
  }
  function renderOutput() {
    $('output-content').hidden = !state.output;
    document.querySelectorAll('.output-tab').forEach((button) => { const active = state.output === button.dataset.value; button.classList.toggle('active', active); button.setAttribute('aria-expanded', String(active)); });
    $('output-toggle').innerHTML = icon(state.output ? 'chevron-down' : 'chevron-up');
    if (!state.output) return;
    if (state.output === 'runtime') $('output-content').innerHTML = '<div class="output-hint">以下为只读模拟日志，无开放终端或命令输入。</div>' + state.logs.map(([time, kind, text]) => `<div class="log-line"><span class="log-time">${time}</span><span class="${kind === 'error' ? 'log-error' : 'log-ok'}">${escapeHTML(text)}</span></div>`).join('');
    else if (state.output === 'checks') $('output-content').innerHTML = '<div class="output-hint">工程检查不代替业务核对 · 本页仅模拟检查结果，不执行真实工具。</div>' + checkNames.map((name, index) => `<div class="check-row"><span class="${state.checkItems[index] === 'failed' ? 'log-error' : state.checkItems[index] === 'passed' ? 'log-ok' : ''}">${icon(state.checkItems[index] === 'passed' ? 'check' : state.checkItems[index] === 'failed' ? 'alert' : 'clock')}</span><span>${name}</span><span>${checkDetails[index]}</span><small>${state.checkRevision !== state.revision && state.checks !== 'running' ? '待重新检查' : { passed: '通过', failed: '失败', pending: '等待中' }[state.checkItems[index]]}</small></div>`).join('');
    else {
      const problems = [];
      if (state.checks === 'failed') problems.push('<div class="check-row log-error">' + icon('alert') + '<span>build</span><span>模拟构建失败：订单页面类型不匹配。</span><button class="text-button" data-action="open-file" data-value="page">查看文件</button></div>');
      if (state.runtime === 'failed') problems.push('<div class="check-row log-error">' + icon('alert') + '<span>启动失败</span><button class="text-button" data-action="restart">重试</button></div>');
      $('output-content').innerHTML = problems.join('') || `<div class="empty-output">${icon('check-circle')}当前没有工程问题。业务是否正确，仍需对照需求核对。</div>`;
    }
  }
  function openDrawer(kind) {
    if (state.submitting) { toast('模拟提交进行中，请稍候。'); return; }
    lastFocus = document.activeElement; state.drawer = kind; $('more-menu').hidden = true; $('more-button').setAttribute('aria-expanded', 'false');
    $('drawer').hidden = false; $('drawer-backdrop').hidden = false;
    const titles = { confirm: '确认当前原型', collection: '需求集合', diagnostics: '诊断信息', diff: '本轮变更对比', demo: '演示状态', guide: '从实现到业务核对', stage: '项目阶段', tasks: '我的事项与队列' };
    $('drawer-title').textContent = titles[kind] || '工作台'; $('drawer-eyebrow').textContent = kind === 'confirm' ? '采购协同原型 · 3 项需求' : '采购协同平台 / 交互原型';
    $('drawer-footer').innerHTML = '';
    if (kind === 'tasks') renderItems();
    else if (kind === 'confirm') renderConfirm();
    else if (kind === 'collection') renderCollection();
    else if (kind === 'diff') renderDiff();
    else if (kind === 'demo') renderDemo();
    else if (kind === 'diagnostics') renderDiagnostics();
    else if (kind === 'guide') $('drawer-body').innerHTML = `<section class="drawer-section"><div class="drawer-notice">本页是可点击设计稿。AI、工程命令、构建与原型确认流程均为模拟，不构成产品验收。</div><h3 style="margin-top:24px">建议按这个顺序体验</h3><ol><li>通过需求集合定位订单、审批和供应商，或在预览内连续切换页面。</li><li>操作订单的新建、校验、保存与错误恢复，查看审批过程与供应商目录。</li><li>点击会话变更文件切到代码，编辑样例并保存，观察工程检查和预览过期。</li><li>运行工程检查，再打开「确认原型」，跨需求核对整体体验。</li><li>发现问题时放入 AI 草稿，继续同一个项目原型的协作。</li></ol></section><section class="drawer-section"><h3>操作边界</h3><p>需求集合仅提供业务上下文与定位，不要求先选定或确认集合。源码是缩略示例，编辑后不会实际执行构建或改变内嵌页面。</p><p>业务核对只记录判断，不新增逐项勾选门禁。未保存修改或工程检查无效会阻止模拟确认。预览停止或过期仅提示作者继续核对。</p><p>所有数据只保留在当前页内存。确认流程展示设计目标，不代表现有协同服务已实现需求集合受理。</p></section>`;
    hydrateIcons($('drawer')); $('drawer').querySelector('button')?.focus();
  }
  function closeDrawer() {
    if (state.submitting) { toast('模拟提交进行中，请稍候。'); return; }
    state.drawer = null; $('drawer').hidden = true; $('drawer-backdrop').hidden = true; lastFocus?.focus();
  }
  const requirements = [
    { id: 'REQ-0012', name: '采购订单管理', route: 'orders', file: 'page', description: '订单录入、筛选、金额计算与草稿编辑。' },
    { id: 'REQ-0013', name: '审批记录', route: 'approvals', file: 'approvals', description: '查看订单审批节点、处理人、意见与结果。' },
    { id: 'REQ-0014', name: '供应商目录', route: 'suppliers', file: 'suppliers', description: '浏览和搜索供应商，核对采购对象信息。' },
  ];
  function renderCollection() {
    $('drawer-body').innerHTML = `<section class="drawer-section"><div class="drawer-notice">同一个项目原型覆盖这 3 项需求。这里帮助你定位相关页面和代码，不切换独立原型，也不重建当前会话。</div></section><div class="requirement-collection">${requirements.map((item) => `<article class="collection-item"><div><span class="code-chip">${item.id}</span><h3>${item.name}</h3></div><p>${item.description}</p><div class="collection-actions"><button class="subtle-button" data-action="collection-preview" data-value="${item.route}">${icon('eye')}查看页面</button><button class="subtle-button" data-action="collection-code" data-value="${item.file}">${icon('code')}定位代码</button></div></article>`).join('')}</div><section class="drawer-section" style="margin-top:22px"><p>需求集合提供业务上下文。可以跨需求查看与持续调整整个项目原型，无需先选定需求范围。</p></section>`;
  }
  function renderDiagnostics() {
    $('drawer-body').innerHTML = `<div class="drawer-notice">以下定位信息为设计示例，未读取真实工程、Git 或服务。</div><section class="drawer-section" style="margin-top:24px"><h3>原型与工作区</h3><dl class="diagnostic-grid"><dt>当前原型</dt><dd>采购协同原型</dd><dt>需求集合</dt><dd>订单、审批、供应商 · 3 项</dd><dt>当前源码</dt><dd>本页修订 ${state.revision}（样例内存）</dd><dt>工程检查</dt><dd>修订 ${state.checkRevision} / ${state.checks}</dd><dt>预览源码</dt><dd>修订 ${state.previewRevision}</dd><dt>工作目录</dt><dd><code>D:/EADP/采购协同平台/原型代码</code></dd><dt>事项／现场</dt><dd>${selectedItem.id} · scene-${selectedItem.id}（模拟）</dd><dt>会话／分支</dt><dd>session-${selectedItem.id} / demo/${selectedItem.id}（模拟）</dd><dt>开发占用</dt><dd>${selectedItem.claims.join("、")} · 林晓 · 模拟占用</dd><dt>认可来源</dt><dd>recognized-demo-a1；仅示意，非真实 Git SHA</dd><dt>预览实例</dt><dd>preview-${selectedItem.id}-r${state.previewRevision}（模拟）</dd><dt>服务版本</dt><dd>未连接；未知</dd><dt>网络行为</dt><dd>无外部请求。页面与合成业务数据均在浏览器内存演示。</dd></dl></section>`;
  }
  function renderDiff(id = state.activeFile || 'page') {
    const file = files[id];
    const before = file.original === file.text ? id === 'page' ? 'export default function PurchaseOrders() {\n  return <div>采购订单</div>;\n}' : '// 本轮变更前的示例内容\n' + file.text.split('\n').slice(0, 5).join('\n') : file.original;
    $('drawer-body').innerHTML = `<div class="drawer-notice">对比用于评审本轮文件变化；这里只展示样例内容，不读取 Git。</div><section class="drawer-section" style="margin-top:19px"><label class="eyebrow" for="diff-select">对比文件</label><select id="diff-select" class="diff-file-select">${Object.entries(files).filter(([, item]) => item.editable).map(([key, item]) => `<option value="${key}" ${id === key ? 'selected' : ''}>${item.path}</option>`).join('')}</select><div class="diff-block"><h4>变更前 · 示例</h4><pre class="diff-before">${escapeHTML(before)}</pre></div><div class="diff-block"><h4>当前源码 · 修订 ${state.revision}</h4><pre class="diff-after">${escapeHTML(file.text)}</pre></div><button class="subtle-button" data-action="diff-file" data-value="${id}">${icon('code')}在代码区打开</button></section>`;
    $('diff-select').addEventListener('change', (event) => renderDiff(event.target.value));
  }
  function renderDemo() {
    $('drawer-body').innerHTML = `<section class="drawer-section"><div class="drawer-notice">这些操作只切换交互稿中的模拟状态。业务故障入口收纳在此，不出现在采购业务主界面。</div></section><div class="demo-options"><button data-action="demo" data-value="run-failure"><span><strong>预览启动失败</strong><small>显示失败与重试；第一次重试可恢复</small></span>${icon('chevron-right')}</button><button data-action="demo" data-value="check-failure"><span><strong>工程检查失败</strong><small>模拟 build 失败，观察确认按钮的阻止原因</small></span>${icon('chevron-right')}</button><button data-action="demo" data-value="save-failure"><span><strong>订单保存失败${state.failSave ? ' · 已开启' : ''}</strong><small>下次保存失败并保留输入；再次保存可恢复</small></span>${icon('chevron-right')}</button><button data-action="demo" data-value="empty"><span><strong>订单空态</strong><small>清空模拟订单，可从空态新建；整页刷新恢复</small></span>${icon('chevron-right')}</button><button data-action="demo" data-value="recover"><span><strong>恢复正常状态</strong><small>保留源码编辑，清除演示故障并重新检查、运行</small></span>${icon('refresh')}</button></div>`;
  }
  function confirmBlockReasons() {
    const reasons = [];
    if (state.editing) reasons.push('当前文件尚在编辑，请先保存或取消。');
    if (state.checks === 'failed') reasons.push('工程检查失败，请修正后重新检查。');
    else if (state.checks === 'running') reasons.push('工程检查正在进行。');
    else if (state.checkRevision !== state.revision || state.checks !== 'passed') reasons.push('当前源码还没有有效的工程检查。');
    return reasons;
  }
  function renderConfirm() {
    if (state.submitted) { renderSuccess(); return; }
    if (state.submitting) return;
    const reasons = confirmBlockReasons();
    $('drawer-body').innerHTML = `<section class="drawer-section"><div class="drawer-notice">确认表示你认可当前项目原型的整体业务体验。工程检查不代替业务核对。</div><div class="info-card"><div class="row"><span>原型需求集合</span><button class="text-button" data-action="drawer" data-value="collection">订单、审批、供应商 · 3 项 ${icon('chevron-right')}</button></div><div class="row"><span>当前源码</span><strong>样例修订 ${state.revision}${state.editing ? ' · 有未保存编辑' : ' · 已保存'}</strong></div><div class="row"><span>工程检查</span><span class="tag ${state.checks === 'passed' && state.checkRevision === state.revision ? 'good' : state.checks === 'failed' ? 'bad' : 'warn'}">${state.checks === 'passed' && state.checkRevision === state.revision ? '5/5 通过' : state.checks === 'failed' ? '检查失败' : state.checks === 'running' ? '检查中' : '待检查'}</span></div><div class="row"><span>预览</span><span class="tag ${state.runtime === 'running' && state.previewRevision === state.revision ? 'good' : 'warn'}">${state.runtime !== 'running' ? '未运行' : state.previewRevision === state.revision ? '对应当前源码' : '旧预览 · 待重建'}</span></div></div>${reasons.length ? `<div class="drawer-notice warning">${reasons.map(escapeHTML).join('<br>')}</div><div style="display:flex;gap:8px;margin-top:10px"><button class="subtle-button" data-action="check" ${state.checks === 'running' ? 'disabled' : ''}>运行工程检查</button><button class="subtle-button" data-action="restart">重新运行预览</button></div>` : ''}</section><section class="drawer-section"><h3>业务核对参考 <span class="eyebrow">用于记录，不是新增勾选门禁</span></h3>${reviewTexts.map((text, index) => `<div class="review-item"><p>${index + 1}. ${text}</p><div class="review-actions">${[['ok', '符合'], ['issue', '有问题'], ['unreviewed', '未核对']].map(([value, label]) => `<button data-action="review" data-index="${index}" data-value="${value}" aria-pressed="${state.review[index] === value}" class="${state.review[index] === value ? 'selected' : ''}">${label}</button>`).join('')}</div>${state.review[index] === 'issue' ? `<div class="issue-draft"><label class="sr-only" for="issue-${index}">核对项 ${index + 1} 的问题说明</label><textarea id="issue-${index}" data-issue="${index}" placeholder="描述具体问题，稍后发给 AI 继续调整…">${escapeHTML(state.issues[index])}</textarea><button class="text-button" data-action="issue-to-ai" data-index="${index}">放入 AI 草稿，继续调整 ${icon('arrow-right')}</button></div>` : ''}</div>`).join('')}</section><section class="drawer-section"><h3>确认说明</h3><p>请结合相关需求核对订单、审批与供应商之间的流程、规则和异常。未核对或问题记录由你判断是否影响本次完成，不自动代替业务判断。</p><p>本交互稿模拟完整原型确认及基线衔接的设计目标，不代表现有协同服务已支持需求集合受理；不执行真实 Git、协同受理或发布。</p><button class="text-button" data-action="optional-review">${icon('spark')}AI 辅助评审（可选）</button></section>`;
    $('drawer-footer').innerHTML = `<button class="subtle-button" data-action="close-drawer">继续核对</button><button class="primary-button" data-action="confirm-submit" ${!canConfirm() ? 'disabled' : ''}>确认当前原型 · 模拟 ${icon('arrow-right')}</button>`;
  }
  function submitConfirm() {
    if (!canConfirm() || state.submitting) { toast('请先处理当前源码、工程检查。'); return; }
    state.submitting = true; const revision = state.revision;
    $('drawer-body').innerHTML = `<div class="baseline-success"><div class="success-mark spinning">${icon('refresh')}</div><h3>正在提交当前原型</h3><p>正在模拟固定源码与后台受理…</p></div><div class="submission-progress"><span>${icon('check')}记录当前原型与源码</span><span>${icon('clock')}等待后台受理</span><span>${icon('clock')}形成可追溯基线</span></div>`;
    $('drawer-footer').innerHTML = '<button class="primary-button" disabled>提交中…</button>';
    setTimeout(() => {
      state.submitting = false;
      if (revision !== state.revision || !canConfirm()) { toast('提交期间状态已变化，请重新核对。'); renderConfirm(); return; }
      state.submitted = true; addLog('模拟后台已接受当前原型，基线 BL-0001 已形成。'); renderSuccess(); renderChrome();
    }, 1250);
  }
  function renderSuccess() {
    $('drawer-body').innerHTML = `<div class="baseline-success"><div class="success-mark">${icon('check')}</div><h3>后台已接受，已形成基线</h3><p>采购协同原型 · BL-0001<br>订单、审批、供应商 / 样例源码修订 ${state.revision}</p><span class="tag good">交互稿模拟结果</span></div><div class="drawer-notice">此状态仅演示完整原型确认后的设计衔接，不表示现有协同服务已支持需求集合确认，也不证明真实后台受理、Git 固定或桌面闭环验收。</div><section class="drawer-section" style="margin-top:23px"><h3>下一步</h3><p>在「基线」查看固定成果，在「交接」准备交付材料。原型仅含页面和 Mock，业务系统实现仍属于后续研发范围。</p></section>`;
    $('drawer-footer').innerHTML = '<button class="subtle-button" data-action="close-drawer">留在原型</button><button class="primary-button" data-action="stage" data-value="基线">查看模拟基线</button>';
  }

  const businessCSS = `
  :root{font-family:"Microsoft YaHei UI","PingFang SC","Segoe UI",sans-serif;color:#25314a;background:#f7f9fc;font-size:12px;line-height:1.55;--blue:#2852b2;--line:#e8ecf3;--muted:#5f6d85}*{box-sizing:border-box}body{margin:0;min-height:100vh}button,input,select,textarea{font:inherit}button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;background:transparent;color:inherit;border-radius:5px}button:hover{background:#eaf0fa}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--blue);outline-offset:3px}input,select,textarea{color:#25314a}svg{width:16px;height:16px;stroke-width:1.6;flex-shrink:0}[hidden]{display:none!important}.top{height:55px;background:white;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 21px;gap:9px}.app-logo{display:grid;place-items:center;width:26px;height:26px;background:#2852b2;color:white;border-radius:7px}.app-name{font-size:13px;font-weight:600}.top-divider{height:15px;width:1px;background:var(--line);margin:0 5px}.top small{font-size:11px;color:#5f6d85}.top-right{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:11px;color:var(--muted)}.sample-tag{border:1px solid #dbe4f4;border-radius:4px;padding:2px 6px;background:#f5f8fe;color:#4d6694}.profile{width:25px;height:25px;border:1px solid #dfe7f3;border-radius:50%;display:grid;place-items:center;color:#4e6d9a;background:#f0f4fa}.body-layout{display:flex;min-height:calc(100vh - 55px)}.sidebar{width:144px;flex-shrink:0;background:#fff;border-right:1px solid var(--line);padding:21px 11px}.nav-label{color:#5f6d85;font-size:11px;letter-spacing:.08em;padding:0 12px;margin:0 0 11px}.nav-btn{width:100%;height:36px;justify-content:flex-start;padding:0 12px;margin:0 0 6px;font-size:12px;gap:10px;color:#5f6d85}.nav-btn.active{background:#edf2fc;color:#2852b2;font-weight:600}.nav-btn svg{width:15px;height:15px}.side-note{border-top:1px solid var(--line);margin-top:27px;padding:15px 10px;color:#5f6d85;font-size:11px;line-height:1.9}.content{padding:25px 27px 30px;min-width:0;flex:1}.crumb{font-size:11px;color:#5f6d85;margin-bottom:14px;display:flex;gap:8px}.crumb span:last-child{color:#576680}.page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:21px}.page-heading h1{font-size:23px;font-weight:600;letter-spacing:-.04em;margin:0 0 4px;color:#23304a}.page-heading p{font-size:11px;color:var(--muted);margin:0}.primary{background:#2852b2;color:white;padding:0 13px;height:33px;font-size:12px;border:1px solid #2852b2;box-shadow:0 2px 4px #1d3f9e12}.primary:hover{background:#204797}.secondary{height:32px;background:white;border:1px solid #dce3ef;padding:0 12px;font-size:12px}.text-button{color:#4166b4;font-size:11px;padding:3px 5px}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 20px}.stat{border:1px solid var(--line);background:white;border-radius:7px;padding:13px 15px}.stat .stat-top{display:flex;align-items:center;justify-content:space-between;color:#5f6d85;font-size:11px}.stat strong{display:block;font:600 23px/1.35 "Segoe UI",sans-serif;margin:6px 0 2px;letter-spacing:-.03em}.stat small{font-size:11px;color:#5f6d85}.stat-icon{background:#f2f5fb;padding:4px;border-radius:5px;display:inline-flex;color:#7790bb}.stat-icon svg{width:13px;height:13px}.table-card{background:white;border:1px solid var(--line);border-radius:8px;overflow:hidden;box-shadow:0 2px 3px #1f355602}.card-toolbar{display:flex;align-items:center;gap:9px;padding:15px;border-bottom:1px solid var(--line)}.search-field{position:relative;flex:1;max-width:230px;display:flex;align-items:center;gap:7px;border:1px solid #e0e5ed;border-radius:5px;padding:0 9px;height:31px;color:#5f6d85;background:#fff}.search-field input{border:0;outline:0;width:100%;min-width:0;font-size:11px;background:transparent}.search-field svg{width:13px;height:13px}.status-select{height:31px;min-width:110px;padding:0 8px;border:1px solid #e0e5ed;border-radius:5px;background:white;color:#5c6b84;font-size:11px}.card-total{font-size:11px;color:#5f6d85;margin-left:auto;white-space:nowrap}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left;white-space:nowrap;font-size:11px}th{padding:11px 13px;background:#fafbfd;color:#5f6d85;font-weight:400;font-size:11px;border-bottom:1px solid var(--line)}td{padding:13px;border-bottom:1px solid #f0f2f6;height:62px}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fbfcff}.order-number{display:block;font:600 11px "Segoe UI",sans-serif;color:#3d5f9d;letter-spacing:.01em}.supplier{font-size:11px;color:#5f6d85;margin-top:4px;display:block}.product{font-size:11px;max-width:130px;overflow:hidden;text-overflow:ellipsis}.sub{font-size:11px;color:#5f6d85;margin-top:3px;display:block}.amount{font:600 12px "Segoe UI",sans-serif;white-space:nowrap}.right{text-align:right}.status{display:inline-flex;align-items:center;gap:4px;font-size:11px;border:1px solid;padding:2px 6px;border-radius:4px;white-space:nowrap}.status:before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor}.status.pending{color:#8b641b;background:#fffaf0;border-color:#f2e5c9}.status.approved{color:#397455;background:#f0f8f3;border-color:#daebdf}.status.draft{color:#5f6d85;background:#f5f7fa;border-color:#e4e8ef}.status.rejected{color:#9d4c43;background:#fdf4f2;border-color:#f0dcd5}.table-footer{border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;padding:12px 15px;color:#5f6d85;font-size:11px}.pagination{display:flex;gap:4px}.pagination button{width:23px;height:23px;border:1px solid var(--line);font-size:11px}.pagination .selected{color:#2852b2;background:#f0f4fc;border-color:#d6e2f7}.empty{text-align:center;padding:50px 20px;color:#5f6d85;min-height:240px}.empty>svg{width:32px;height:32px;color:#b4bfd0;margin-bottom:7px}.empty h3{font-size:13px;color:#61728d;font-weight:500;margin:5px}.empty p{font-size:11px;margin:7px 0 15px}.page-note{color:#5f6d85;font-size:11px;margin:13px 1px;display:flex;align-items:center;gap:5px}.page-note svg{width:11px;height:11px}.approval-title{font-size:12px;font-weight:500}.approval-meta{margin-top:4px;font-size:11px;color:#5f6d85}.view-backdrop{position:fixed;inset:0;background:#23314a35;z-index:5}.order-drawer{position:fixed;z-index:6;right:0;top:0;bottom:0;width:370px;max-width:95vw;display:flex;flex-direction:column;background:white;box-shadow:-10px 0 40px #20304a26}.drawer-head{padding:20px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}.drawer-head h2{font-size:16px;margin:0 0 3px;font-weight:600}.drawer-head p{font-size:11px;color:#5f6d85;margin:0}.icon{width:28px;height:28px;padding:0}.form-body{padding:20px 22px;overflow:auto;flex:1}.form-field{display:flex;flex-direction:column;gap:6px;margin-bottom:16px;font-size:12px}.form-field label{color:#64738b}.required{color:#a35144;font-size:11px;margin-left:3px}.form-field input,.form-field textarea,.form-field select{width:100%;border:1px solid #dbe2ee;border-radius:5px;background:#fff;padding:8px 9px;font-size:12px;min-width:0}.form-field input:disabled,.form-field textarea:disabled{background:#f8f9fc;color:#5f6d85}.form-field input[aria-invalid=true]{border-color:#c27668}.field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field-error{font-size:11px;color:#b15d4d;min-height:0}.field-help{font-size:11px;color:#5f6d85}.amount-box{background:#f4f7fc;border:1px solid #e3eaf6;display:flex;justify-content:space-between;align-items:center;border-radius:6px;padding:13px;margin-bottom:18px;color:#5f6d85;font-size:11px}.amount-box strong{font:600 21px "Segoe UI",sans-serif;color:#2e4b7e}.form-footer{padding:15px 22px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px}.form-error{padding:9px 11px;border:1px solid #eacdc5;border-radius:5px;background:#fdf5f2;color:#a25c4f;font-size:11px;margin-bottom:15px}.form-error:focus{outline:2px solid #c27668}.readonly-note{background:#f5f7fb;padding:10px 12px;font-size:11px;color:#5f6d85;border-radius:5px;margin-bottom:18px}.business-toast{position:fixed;z-index:12;bottom:20px;left:50%;transform:translateX(-50%);background:#29354b;color:white;border-radius:6px;padding:10px 16px;box-shadow:0 6px 20px #1727442b;font-size:12px;max-width:90vw}.timeline{margin:10px 0;padding-left:17px;list-style:none}.timeline li{border-left:1px solid #dbe3f1;position:relative;padding:0 0 24px 19px}.timeline li:before{position:absolute;content:"";width:7px;height:7px;left:-4px;top:5px;border-radius:50%;background:#7d9bc4;border:2px solid #e8f0fc}.timeline strong{font-size:12px;display:block;font-weight:500}.timeline p{font-size:11px;color:#5f6d85;margin:5px 0}.timeline small{font-size:11px;color:#5f6d85}.timeline li:last-child{border-color:transparent}.timeline-note{font-size:12px;color:#5f6d85;background:#f4f7fc;padding:12px;border-radius:6px}
  .supplier-details{display:grid;grid-template-columns:80px 1fr;gap:14px 10px;margin:25px 0;font-size:12px}.supplier-details dt{color:#5f6d85}.supplier-details dd{margin:0}
  input::placeholder,textarea::placeholder{color:#5f6d85;opacity:1}
  @media(max-width:850px){.sidebar{width:120px;padding:21px 7px}.content{padding:22px 20px}.top{padding:0 16px}.card-toolbar{padding:12px}.table-scroll th,.table-scroll td{padding-left:10px;padding-right:10px}.stat{padding:11px 12px}.product{max-width:110px}}
  @media(max-width:680px){.sidebar{display:none}.content{padding:20px 17px}.top small,.top-divider{display:none}.top-right{gap:7px}.page-heading h1{font-size:21px}.stat strong{font-size:21px}.card-total{display:none}.table-scroll table{min-width:600px}.stats{gap:8px}.stat{padding:10px}.nav-mobile{display:flex!important;gap:3px;background:white;padding:7px 16px;border-bottom:1px solid var(--line)}.nav-mobile button{font-size:11px;padding:5px 10px;color:#5f6d85}.nav-mobile .active{background:#edf2fc;color:#2852b2}.body-layout{min-height:calc(100vh - 97px)}}
  @media(max-width:430px){.content{padding:18px 13px}.top{padding:0 13px}.top-right>span:first-child{display:none}.stats{grid-template-columns:repeat(3,minmax(0,1fr))}.stat small{display:none}.stat .stat-icon{display:none}.stat strong{font-size:20px}.stat .stat-top{font-size:11px}.page-heading p{max-width:185px;font-size:11px}.page-heading .primary{padding:0 9px;font-size:11px}.card-toolbar{gap:7px;padding:10px}.status-select{min-width:95px}.search-field{padding:0 7px}.table-footer{padding:10px}.order-drawer{max-width:100vw;width:100vw}.page-note{font-size:11px}}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important}}
  `;
  // Executed inside the sandboxed preview; all business data is synthetic and local.
  function businessApp(config, icons) {
    'use strict';
    const root = document.getElementById('business-root');
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.document}"/></svg>`;
    const money = (value) => Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const labels = { pending: '审批中', approved: '已通过', draft: '草稿', rejected: '已驳回' };
    const initial = [
      { id: '1', number: 'PO-20261026-001', supplier: '华东办公用品', product: '人体工学办公椅', quantity: 20, unitPrice: 680, status: 'pending', date: '2026-10-26', delivery: '2026-11-05', notes: '研发办公区设备补充' },
      { id: '2', number: 'PO-20261025-008', supplier: '启明电子科技', product: '27 英寸显示器', quantity: 12, unitPrice: 1899, status: 'approved', date: '2026-10-25', delivery: '2026-11-01', notes: '' },
      { id: '3', number: 'PO-20261025-006', supplier: '远山工业设备', product: '仓储标签打印机', quantity: 3, unitPrice: 2450, status: 'draft', date: '2026-10-25', delivery: '2026-11-08', notes: '采购前请确认标签规格' },
      { id: '4', number: 'PO-20261024-015', supplier: '华东办公用品', product: '会议室白板套装', quantity: 6, unitPrice: 360, status: 'approved', date: '2026-10-24', delivery: '2026-10-31', notes: '' },
      { id: '5', number: 'PO-20261024-009', supplier: '辰星网络设备', product: '千兆交换机', quantity: 4, unitPrice: 1280, status: 'pending', date: '2026-10-24', delivery: '2026-11-02', notes: '' },
    ];
    let orders = config.orders || (config.empty ? [] : initial);
    const suppliers = [
      { id: 'S001', name: '华东办公用品', category: '办公家具与耗材', contact: '沈佳', phone: '021-5550-1201', city: '上海', status: '合作中' },
      { id: 'S002', name: '启明电子科技', category: '电脑与显示设备', contact: '顾晨', phone: '0571-5550-2302', city: '杭州', status: '合作中' },
      { id: 'S003', name: '远山工业设备', category: '工业与仓储设备', contact: '周禾', phone: '025-5550-3403', city: '南京', status: '合作中' },
      { id: 'S004', name: '辰星网络设备', category: '网络与通信设备', contact: '陆言', phone: '0512-5550-4504', city: '苏州', status: '合作中' },
    ];
    let route = config.route || 'orders', keyword = '', supplierKeyword = '', status = 'all', formOrder = null, failSave = config.failSave;
    let lastFocus = null, noticeTimer, saving = false;
    function post(type, payload) { if (parent !== window) parent.postMessage({ source: 'eadp-prototype-demo', type, ...payload }, '*'); }
    function notify(text) { const node = document.getElementById('business-toast'); node.textContent = text; node.hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { node.hidden = true; }, 2700); }
    function nav() { return `<button class="nav-btn ${route === 'orders' ? 'active' : ''}" data-business="route" data-value="orders">${svg('package')}采购订单</button><button class="nav-btn ${route === 'approvals' ? 'active' : ''}" data-business="route" data-value="approvals">${svg('clock')}审批记录</button><button class="nav-btn ${route === 'suppliers' ? 'active' : ''}" data-business="route" data-value="suppliers">${svg('files')}供应商目录</button>`; }
    function render() {
      root.innerHTML = `<header class="top"><span class="app-logo">${svg('layers')}</span><span class="app-name">采购协同</span><span class="top-divider"></span><small>让每一笔采购井然有序</small><div class="top-right"><span class="sample-tag">合成数据演示</span><span>采购工作台</span><span class="profile">林</span></div></header><nav class="nav-mobile" style="display:none" aria-label="业务页面">${nav()}</nav><div class="body-layout"><aside class="sidebar"><p class="nav-label">采购工作空间</p><nav aria-label="业务导航">${nav()}</nav><div class="side-note">仅展示页面与业务交互<br>未连接真实采购系统</div></aside><main class="content"><div class="crumb"><span>采购管理</span><span>/</span><span>${route === 'orders' ? '采购订单' : route === 'approvals' ? '审批记录' : '供应商目录'}</span></div>${route === 'orders' ? renderOrders() : route === 'approvals' ? renderApprovals() : renderSuppliers()}</main></div><div class="view-backdrop" id="order-backdrop" hidden></div><aside id="order-drawer" class="order-drawer" role="dialog" aria-modal="true" aria-labelledby="order-title" tabindex="-1" hidden></aside><div class="business-toast" id="business-toast" role="status" hidden></div>`;
      if (route === 'orders') { document.getElementById('order-search').value = keyword; document.getElementById('status-filter').value = status; renderRows(); }
      if (route === 'suppliers') { document.getElementById('supplier-search').value = supplierKeyword; renderSupplierRows(); }
    }
    function renderOrders() {
      const total = orders.reduce((sum, order) => sum + order.quantity * order.unitPrice, 0);
      return `<div class="page-heading"><div><h1>采购订单</h1><p>从订单创建到审批，清晰掌握每一笔采购。</p></div><button class="primary" data-business="new">${svg('plus')}新建订单</button></div><section class="stats" aria-label="订单概况"><div class="stat"><div class="stat-top"><span>全部订单</span><span class="stat-icon">${svg('package')}</span></div><strong>${orders.length.toString().padStart(2, '0')}</strong><small>当前演示数据</small></div><div class="stat"><div class="stat-top"><span>待审批</span><span class="stat-icon">${svg('clock')}</span></div><strong>${orders.filter((order) => order.status === 'pending').length.toString().padStart(2, '0')}</strong><small>等待业务处理</small></div><div class="stat"><div class="stat-top"><span>订单总额</span><span class="stat-icon">${svg('layers')}</span></div><strong><span style="font-size:13px;margin-right:3px">¥</span>${money(total).split('.')[0]}</strong><small>人民币 · 含全部状态</small></div></section><section class="table-card"><div class="card-toolbar"><label class="search-field">${svg('search')}<span class="sr-only" style="position:absolute;clip:rect(0,0,0,0)">搜索订单编号或供应商</span><input id="order-search" placeholder="搜索订单编号 / 供应商" aria-label="搜索订单编号或供应商"></label><select class="status-select" id="status-filter" aria-label="按订单状态筛选"><option value="all">全部状态</option><option value="draft">草稿</option><option value="pending">审批中</option><option value="approved">已通过</option></select><span class="card-total">合成业务样本</span></div><div id="order-table"></div><div class="table-footer"><span id="results-label"></span><div class="pagination"><button disabled aria-label="上一页">‹</button><button class="selected" aria-current="page" data-business="page-info">1</button><button disabled aria-label="下一页">›</button></div></div></section><p class="page-note">${svg('shield')}原型数据仅用于业务核对，不会触达真实业务服务</p>`;
    }
    function renderRows() {
      const visible = orders.filter((order) => (!keyword || order.number.toLowerCase().includes(keyword.toLowerCase()) || order.supplier.includes(keyword)) && (status === 'all' || order.status === status));
      document.getElementById('results-label').textContent = `共 ${visible.length} 条${keyword || status !== 'all' ? '匹配结果' : '订单'} · 每页 10 条`;
      document.getElementById('order-table').innerHTML = !visible.length ? `<div class="empty">${svg('package')}<h3>${orders.length ? '没有找到匹配订单' : '还没有采购订单'}</h3><p>${orders.length ? '试试其他关键词，或清除筛选条件。' : '创建第一笔订单，开始整理采购工作。'}</p><button class="secondary" data-business="${orders.length ? 'clear-filter' : 'new'}">${orders.length ? '清除筛选' : '新建订单'}</button></div>` : `<div class="table-scroll"><table><thead><tr><th>订单编号 / 供应商</th><th>采购内容</th><th class="right">订单金额</th><th>状态</th><th>创建日期</th><th class="right">操作</th></tr></thead><tbody>${visible.map((order) => `<tr><td><span class="order-number">${order.number}</span><span class="supplier">${esc(order.supplier)}</span></td><td><span class="product">${esc(order.product)}</span><span class="sub">${order.quantity} 件 × ¥${money(order.unitPrice)}</span></td><td class="right amount">¥${money(order.quantity * order.unitPrice)}</td><td><span class="status ${order.status}">${labels[order.status]}</span></td><td style="color:#5f6d85;font-size:9px">${order.date}</td><td class="right"><button class="text-button" data-business="open" data-id="${order.id}">${order.status === 'draft' ? '编辑' : '查看'}</button></td></tr>`).join('')}</tbody></table></div>`;
    }
    function renderApprovals() {
      return `<div class="page-heading"><div><h1>审批记录</h1><p>按订单追溯处理节点，保留每一次业务决定。</p></div><button class="secondary" data-business="route" data-value="orders">返回订单</button></div><section class="table-card"><div class="card-toolbar"><strong style="font-size:12px;font-weight:500">最近审批</strong><span class="card-total">2 条合成记录</span></div><div class="table-scroll"><table><thead><tr><th>采购订单</th><th>申请人</th><th>当前节点</th><th>处理人</th><th>结果</th><th class="right">操作</th></tr></thead><tbody><tr><td><span class="order-number">PO-20261026-001</span><span class="supplier">人体工学办公椅 · ¥13,600.00</span></td><td>林晓</td><td>部门审批</td><td>陈明</td><td><span class="status pending">处理中</span></td><td class="right"><button class="text-button" data-business="approval" data-id="pending">查看过程</button></td></tr><tr><td><span class="order-number">PO-20261025-008</span><span class="supplier">27 英寸显示器 · ¥22,788.00</span></td><td>林晓</td><td>审批完成</td><td>周宁</td><td><span class="status approved">已通过</span></td><td class="right"><button class="text-button" data-business="approval" data-id="approved">查看过程</button></td></tr></tbody></table></div><div class="table-footer"><span>合成审批记录 · 不执行真实审批</span><span>最近更新 10:25</span></div></section><p class="page-note">${svg('clock')}审批节点、处理意见与时间均为交互演示样例</p>`;
    }
    function renderSuppliers() {
      return `<div class="page-heading"><div><h1>供应商目录</h1><p>查阅采购伙伴、品类与联系信息。</p></div><span class="sample-tag">4 家合成供应商</span></div><section class="table-card"><div class="card-toolbar"><label class="search-field">${svg('search')}<input id="supplier-search" placeholder="搜索名称 / 采购类别" aria-label="搜索供应商名称或采购类别"></label><span class="card-total">采购订单的供应商参考</span></div><div id="supplier-table"></div><div class="table-footer"><span id="supplier-results"></span><span>目录只读 · 合成数据</span></div></section><p class="page-note">${svg('shield')}联系方式为虚构样例，可从供应商查看相关采购订单</p>`;
    }
    function renderSupplierRows() {
      const visible = suppliers.filter((item) => !supplierKeyword || (item.name + item.category).includes(supplierKeyword));
      document.getElementById('supplier-results').textContent = `共 ${visible.length} 家供应商`;
      document.getElementById('supplier-table').innerHTML = !visible.length ? `<div class="empty">${svg('search')}<h3>没有找到匹配供应商</h3><p>试试其他名称或采购类别。</p><button class="secondary" data-business="clear-supplier-search">清除搜索</button></div>` : `<div class="table-scroll"><table><thead><tr><th>供应商</th><th>采购类别</th><th>联系人</th><th>状态</th><th class="right">操作</th></tr></thead><tbody>${visible.map((item) => `<tr><td><strong style="font-weight:500">${item.name}</strong><span class="supplier">${item.id} · ${item.city}</span></td><td>${item.category}</td><td>${item.contact}</td><td><span class="status approved">${item.status}</span></td><td class="right"><button class="text-button" data-business="supplier" data-id="${item.id}">查看详情</button></td></tr>`).join('')}</tbody></table></div>`;
    }
    function showSupplier(id) {
      const item = suppliers.find((supplier) => supplier.id === id); if (!item) return;
      lastFocus = document.activeElement;
      document.getElementById('order-drawer').innerHTML = `<header class="drawer-head"><div><h2 id="order-title">${item.name}</h2><p>${item.id} · 供应商资料</p></div><button class="icon" data-business="close" aria-label="关闭供应商详情">${svg('close')}</button></header><div class="form-body"><span class="status approved">${item.status}</span><dl class="supplier-details"><dt>采购类别</dt><dd>${item.category}</dd><dt>所在城市</dt><dd>${item.city}</dd><dt>联系人</dt><dd>${item.contact}</dd><dt>联系电话</dt><dd>${item.phone}</dd></dl><p class="timeline-note">供应商信息与联系方式均为虚构演示。目录只读，不执行真实联系或供应商维护。</p><button class="secondary" style="margin-top:16px" data-business="supplier-orders" data-id="${item.id}">查看相关采购订单</button></div><footer class="form-footer"><button class="secondary" data-business="close">关闭</button></footer>`;
      document.getElementById('order-drawer').hidden = false; document.getElementById('order-backdrop').hidden = false; document.querySelector('#order-drawer button').focus();
    }
    function showOrder(order = null) {
      lastFocus = document.activeElement; formOrder = order; const readonly = order && order.status !== 'draft';
      const values = order || { supplier: '', product: '', quantity: 1, unitPrice: '', delivery: '', notes: '' };
      const field = (name, label, type, value, extra = '') => `<div class="form-field"><label for="field-${name}">${label}${['supplier', 'product', 'quantity', 'unitPrice'].includes(name) ? '<span class="required">*</span>' : ''}</label><input id="field-${name}" name="${name}" type="${type}" value="${esc(value)}" ${readonly ? 'disabled' : ''} ${extra}><span class="field-error" id="error-${name}"></span></div>`;
      document.getElementById('order-drawer').innerHTML = `<header class="drawer-head"><div><h2 id="order-title">${order ? readonly ? '订单详情' : '编辑订单' : '新建采购订单'}</h2><p>${order ? order.number : '保存后生成订单编号，状态为草稿'}</p></div><button class="icon" data-business="close" aria-label="关闭订单面板">${svg('close')}</button></header><form id="order-form" novalidate style="display:contents"><div class="form-body">${readonly ? `<div class="readonly-note">${labels[order.status]}订单只读。仅草稿订单允许修改。</div>` : ''}<div id="form-error" class="form-error" role="alert" tabindex="-1" hidden></div>${field('supplier', '供应商', 'text', values.supplier, 'maxlength="60" placeholder="请输入供应商名称"')}${field('product', '采购内容', 'text', values.product, 'maxlength="80" placeholder="例如：人体工学办公椅"')}<div class="field-row">${field('quantity', '数量（件）', 'number', values.quantity, 'min="1" max="999999" step="1" inputmode="numeric"')}${field('unitPrice', '单价（元）', 'number', values.unitPrice, 'min="0.01" max="99999999" step="0.01" inputmode="decimal"')}</div><div class="amount-box"><span>订单金额 · 自动计算</span><strong id="calculated-amount">¥${money(Number(values.quantity) * Number(values.unitPrice))}</strong></div>${field('delivery', '期望交付日期', 'date', values.delivery)}<div class="form-field"><label for="field-notes">备注</label><textarea id="field-notes" rows="3" maxlength="300" ${readonly ? 'disabled' : ''} placeholder="补充采购用途或交付说明">${esc(values.notes)}</textarea></div><div class="field-help">合成数据演示，保存不会发送到真实采购系统。</div></div><footer class="form-footer"><button type="button" class="secondary" data-business="close">${readonly ? '关闭' : '取消'}</button>${!readonly ? '<button type="submit" class="primary" id="order-save">保存订单</button>' : ''}</footer></form>`;
      document.getElementById('order-backdrop').hidden = false; document.getElementById('order-drawer').hidden = false;
      document.getElementById(readonly ? 'order-drawer' : 'field-supplier').focus();
      if (!readonly) document.getElementById('order-form').addEventListener('submit', saveOrder);
    }
    function closeOrder() { if (saving) return; document.getElementById('order-drawer').hidden = true; document.getElementById('order-backdrop').hidden = true; formOrder = null; lastFocus?.focus(); }
    function showApproval(id) {
      lastFocus = document.activeElement; const passed = id === 'approved';
      document.getElementById('order-drawer').innerHTML = `<header class="drawer-head"><div><h2 id="order-title">审批过程</h2><p>PO-202610${passed ? '25-008' : '26-001'}</p></div><button class="icon" data-business="close" aria-label="关闭审批面板">${svg('close')}</button></header><div class="form-body"><span class="status ${passed ? 'approved' : 'pending'}">${passed ? '已通过' : '审批中'}</span><ol class="timeline" style="margin-top:28px"><li><strong>提交采购申请</strong><p>林晓 · 申请人</p><small>2026-10-${passed ? '25' : '26'} 09:12</small></li><li><strong>部门审批${passed ? ' · 通过' : ' · 等待处理'}</strong><p>陈明 · 部门负责人</p><small>${passed ? '2026-10-25 10:36 · 同意采购，按计划交付' : '2026-10-26 09:13 · 已送达'}</small></li>${passed ? '<li><strong>采购复核 · 通过</strong><p>周宁 · 采购负责人</p><small>2026-10-25 14:20 · 供应商与金额核对无误</small></li>' : ''}</ol><p class="timeline-note">此处仅展示审批记录。审批操作不在本需求原型范围。</p></div><footer class="form-footer"><button class="secondary" data-business="close">关闭</button></footer>`;
      document.getElementById('order-drawer').hidden = false; document.getElementById('order-backdrop').hidden = false; document.querySelector('#order-drawer button').focus();
    }
    async function saveOrder(event) {
      event.preventDefault(); if (saving) return;
      const val = (name) => document.getElementById('field-' + name).value.trim();
      const values = { supplier: val('supplier'), product: val('product'), quantity: Number(val('quantity')), unitPrice: Number(val('unitPrice')), delivery: val('delivery'), notes: val('notes') };
      const errors = { supplier: !values.supplier ? '请输入供应商名称' : '', product: !values.product ? '请输入采购内容' : '', quantity: !Number.isInteger(values.quantity) || values.quantity < 1 || values.quantity > 999999 ? '数量须为 1–999999 的整数' : '', unitPrice: !Number.isFinite(values.unitPrice) || values.unitPrice <= 0 || values.unitPrice > 99999999 || !/^\d+(\.\d{1,2})?$/.test(val('unitPrice')) ? '单价须大于 0，且最多两位小数' : '' };
      Object.entries(errors).forEach(([name, error]) => { document.getElementById('error-' + name).textContent = error; document.getElementById('field-' + name).setAttribute('aria-invalid', String(Boolean(error))); document.getElementById('field-' + name).setAttribute('aria-describedby', 'error-' + name); });
      const firstError = Object.entries(errors).find(([, error]) => error);
      if (firstError) { document.getElementById('field-' + firstError[0]).focus(); return; }
      saving = true; const save = document.getElementById('order-save'); save.disabled = true; save.textContent = '保存中…';
      await new Promise((resolve) => setTimeout(resolve, 500)); saving = false;
      if (failSave) { failSave = false; post('save-failure-consumed', {}); const error = document.getElementById('form-error'); error.textContent = '保存失败（模拟）：服务暂时不可用。输入已保留，请重试。'; error.hidden = false; error.focus(); save.disabled = false; save.textContent = '重试保存'; return; }
      const saved = { ...values, id: formOrder?.id || 'demo-' + Date.now(), number: formOrder?.number || 'PO-20261026-' + String(orders.length + 1).padStart(3, '0'), status: 'draft', date: formOrder?.date || '2026-10-26' };
      orders = formOrder ? orders.map((order) => order.id === formOrder.id ? saved : order) : [saved, ...orders];
      closeOrder(); post('orders-updated', { orders }); keyword = ''; status = 'all'; render(); notify('订单已保存为草稿（模拟）');
    }
    document.addEventListener('click', (event) => {
      const control = event.target.closest('[data-business]'); if (!control) return;
      const action = control.dataset.business;
      if (action === 'route') { route = control.dataset.value; render(); post('route', { route }); }
      else if (action === 'new') showOrder();
      else if (action === 'open') showOrder(orders.find((order) => order.id === control.dataset.id));
      else if (action === 'close') closeOrder();
      else if (action === 'approval') showApproval(control.dataset.id);
      else if (action === 'clear-filter') { keyword = ''; status = 'all'; render(); }
      else if (action === 'page-info') notify('当前合成数据仅一页');
      else if (action === 'supplier') showSupplier(control.dataset.id);
      else if (action === 'clear-supplier-search') { supplierKeyword = ''; render(); }
      else if (action === 'supplier-orders') { const item = suppliers.find((supplier) => supplier.id === control.dataset.id); keyword = item?.name || ''; status = 'all'; route = 'orders'; render(); post('route', { route }); }
    });
    document.addEventListener('input', (event) => {
      if (event.target.id === 'order-search') { keyword = event.target.value.trim(); renderRows(); }
      if (event.target.id === 'supplier-search') { supplierKeyword = event.target.value.trim(); renderSupplierRows(); }
      if (event.target.id === 'field-quantity' || event.target.id === 'field-unitPrice') {
        const amount = Number(document.getElementById('field-quantity').value) * Number(document.getElementById('field-unitPrice').value);
        document.getElementById('calculated-amount').textContent = Number.isFinite(amount) && amount > 0 ? '¥' + money(amount) : '¥0.00';
      }
    });
    document.addEventListener('change', (event) => { if (event.target.id === 'status-filter') { status = event.target.value; renderRows(); } });
    document.addEventListener('keydown', (event) => {
      const drawer = document.getElementById('order-drawer');
      if (!drawer || drawer.hidden) { if (event.key === 'Escape') post('escape-preview', {}); return; }
      if (event.key === 'Escape') closeOrder();
      if (event.key === 'Tab') {
        const focusable = [...drawer.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')];
        if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
      }
    });
    document.addEventListener('click', (event) => { if (event.target.id === 'order-backdrop') closeOrder(); });
    render(); post('ready', {});
  }
  function previewDocument() {
    const config = { route: state.route, failSave: state.failSave, empty: state.emptyPreview, orders: state.businessOrders };
    // Escaping closing script sequences keeps generated srcdoc content inert until its intended script.
    const script = `(${businessApp.toString()})(${JSON.stringify(config)},${JSON.stringify(paths)});`.replace(/<\/script/gi, '<\\/script');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>采购协同 · 合成业务预览</title><style>${businessCSS}</style></head><body><div id="business-root"></div><script>${script}<\/script></body></html>`;
  }
  function mountPreview() { $('business-preview').srcdoc = previewDocument(); }

  function demoState(kind) {
    closeDrawer(); state.submitted = false;
    if (kind === 'run-failure') { ++runtimeToken; state.runtime = 'failed'; state.failNextRun = false; addLog('已切换到模拟启动失败；可重试。', 'error'); }
    else if (kind === 'check-failure') { state.failChecks = true; runChecks(); toast('已开启 build 失败演示。通过「恢复正常状态」清除故障。'); }
    else if (kind === 'save-failure') { state.failSave = true; state.mode = 'preview'; if (state.runtime !== 'running') state.runtime = 'running'; mountPreview(); toast('下次订单保存将失败，输入保留，再次保存可恢复。'); }
    else if (kind === 'empty') { state.emptyPreview = true; state.businessOrders = []; state.mode = 'preview'; state.runtime = 'running'; mountPreview(); toast('已切换为无订单空态，可新建订单。'); }
    else if (kind === 'recover') { state.failChecks = false; state.failNextRun = false; state.failSave = false; state.emptyPreview = false; state.businessOrders = undefined; runChecks(); runPreview(); toast('已清除演示故障，保留当前样例源码。'); }
    renderChrome(); if (state.output) renderOutput();
  }
  function stageInfo(stage) {
    openDrawer('stage'); $('drawer-title').textContent = stage;
    const descriptions = { 场景: '从采购业务流程中识别需求，帮助理解订单、审批与供应商之间的关系。', 需求: '项目内的多项需求共同构成原型上下文。你可以通过需求集合定位相关页面和代码。', 原型: '同一个项目原型持续整合多项需求，查看实现、操作预览并核对整体业务体验。', 基线: state.submitted ? 'BL-0001 · 采购协同原型。当前页仅模拟整个原型确认后形成源码基线的设计目标。' : '确认当前原型后，基线用于追溯代码成果。本稿尚未演示形成基线。', 交接: '以原型代码基线及相关需求准备业务说明、交互限制和待澄清项，交给研发继续实现业务系统。' };
    $('drawer-body').innerHTML = `<section class="drawer-section"><div class="drawer-notice">其他阶段仅展示衔接说明；本交互稿聚焦项目原型工作台。</div><h3 style="margin-top:24px">${stage}阶段</h3><p>${descriptions[stage] || ''}</p>${stage === '基线' && state.submitted ? '<div class="info-card"><strong>BL-0001 · 采购协同原型</strong><p>交互稿模拟结果 · 集合受理为设计目标，无真实 Git 或协同受理</p></div>' : ''}</section>`;
    $('drawer-footer').innerHTML = '<button class="primary-button" data-action="close-drawer">返回原型工作台</button>';
  }
  function issueToAI(index) {
    state.issues[index] = $('issue-' + index)?.value || state.issues[index];
    $('chat-input').value = `请继续调整采购协同原型：\n核对项：${reviewTexts[index]}\n具体问题：${state.issues[index] || '请结合当前页面核对并给出调整建议。'}`;
    closeDrawer(); state.aiCollapsed = false; $('workspace-body').classList.add('ai-expanded'); renderChrome(); $('chat-input').focus(); toast('问题已放入 AI 输入草稿，尚未发送。');
  }
  const actions = {
    'item-switch': (control) => switchItem(control.dataset.value),
    'item-continue': continueItem,
    'item-enqueue': enqueueItem,
    'item-enqueue-retry': () => { externalApprovalOccupied = false; enqueueItem(); },
    'item-pause': () => { selectedItem.phase = '已暂停'; taskNotice = '已暂停模拟执行；原开发占用保留，没有自动开始下一项。'; renderChrome(); renderItems(); },
    'item-expand': () => { if (selectedItem.claims.includes('REQ-0013')) { taskNotice = '当前事项已持有 REQ-0013，无需重复扩领。'; renderItems(); return; } expansionFailed = true; taskNotice = '扩领失败：REQ-0013 由陈明开发中（模拟）。原开发范围、源码和会话保留，审批材料仍可只读参考。'; renderItems(); },
    'item-expand-retry': () => { const existing = items.find((item) => item !== selectedItem && item.claims.includes('REQ-0013')); if (existing) { taskNotice = `扩领失败：REQ-0013 仍由本人事项「${existing.title}」开发。原范围保留。`; renderItems(); return; } externalApprovalOccupied = false; if (!selectedItem.claims.includes('REQ-0013')) selectedItem.claims.push('REQ-0013'); expansionFailed = false; taskNotice = '恢复样本：对方已释放，扩领成功（模拟）。仅更新开发范围，未自动发消息或修改代码。'; renderChrome(); renderItems(); },
    drawer: (control) => openDrawer(control.dataset.value), 'close-drawer': closeDrawer,
    mode: (control) => guardUnsaved(() => setMode(control.dataset.value)),
    'open-file': (control) => openFile(control.dataset.value), 'close-file': (control) => closeFile(control.dataset.value),
    'edit-file': beginEdit, 'cancel-edit': cancelEdit, 'save-file': saveEdit,
    'toggle-ai': () => { const narrow = window.innerWidth <= 1100; if (narrow && !$('workspace-body').classList.contains('ai-expanded')) state.aiCollapsed = false; else state.aiCollapsed = !state.aiCollapsed; $('workspace-body').classList.toggle('ai-expanded', !state.aiCollapsed); renderChrome(); },
    'toggle-tree': () => { const narrow = window.innerWidth <= 800; if (narrow && !$('code-pane').classList.contains('tree-expanded')) state.treeCollapsed = false; else state.treeCollapsed = !state.treeCollapsed; $('code-pane').classList.toggle('tree-expanded', !state.treeCollapsed); renderChrome(); },
    run: toggleRun, restart: runPreview, check: runChecks,
    more: () => { $('more-menu').hidden = !$('more-menu').hidden; $('more-button').setAttribute('aria-expanded', String(!$('more-menu').hidden)); if (!$('more-menu').hidden) $('more-menu').querySelector('button')?.focus(); },
    output: (control) => { state.output = state.output === control.dataset.value ? null : control.dataset.value; renderOutput(); },
    'collapse-output': () => { state.output = state.output ? null : 'runtime'; renderOutput(); },
    'refresh-preview': () => { if (state.runtime !== 'running') { toast('请先运行预览。'); return; } mountPreview(); toast('已刷新固定业务演示，当前筛选与未保存的订单输入将重置。'); },
    device: (control) => { state.device = control.dataset.value; renderChrome(); },
    fullscreen: () => { const expanded = $('preview-pane').classList.toggle('preview-expanded'); document.querySelector('[data-action="fullscreen"]').setAttribute('aria-pressed', String(expanded)); toast(expanded ? '已展开预览。Escape 可退出。' : '已退出全屏预览。'); },
    external: () => { if (state.runtime !== 'running') { toast('请先运行预览。'); return; } const preview = window.open('', '_blank'); if (!preview) { toast('新窗口被浏览器拦截，请允许弹出窗口后重试。'); return; } preview.opener = null; preview.document.open(); preview.document.write(previewDocument()); preview.document.close(); toast('已在新窗口打开独立演示；新窗口数据不回写工作台。'); },
    'search-next': () => searchCode(true),
    'unsaved-cancel': () => { state.pendingAction = null; $('unsaved-dialog').close(); },
    'unsaved-discard': () => { const callback = state.pendingAction; state.pendingAction = null; $('unsaved-dialog').close(); cancelEdit(); callback?.(); },
    'unsaved-save': () => { const callback = state.pendingAction; state.pendingAction = null; $('unsaved-dialog').close(); saveEdit(); callback?.(); },
    'collection-preview': (control) => { const route = control.dataset.value; closeDrawer(); guardUnsaved(() => { state.route = route; state.mode = 'preview'; renderChrome(); if (state.runtime === 'running') mountPreview(); else toast('页面已定位，运行预览后即可查看。'); }); },
    'collection-code': (control) => { const id = control.dataset.value; closeDrawer(); openFile(id); },
    'diff-file': (control) => { closeDrawer(); openFile(control.dataset.value); },
    demo: (control) => demoState(control.dataset.value),
    review: (control) => { const { index, value } = control.dataset; state.review[Number(index)] = value; renderConfirm(); $('drawer-body').querySelector(`[data-action="review"][data-index="${index}"][data-value="${value}"]`)?.focus(); },
    'issue-to-ai': (control) => issueToAI(Number(control.dataset.index)),
    'optional-review': () => { $('chat-input').value = '请辅助评审采购协同原型与需求集合的差异，列出可定位的问题和依据。'; closeDrawer(); state.aiCollapsed = false; $('workspace-body').classList.add('ai-expanded'); renderChrome(); $('chat-input').focus(); toast('可选评审已放入 AI 草稿，尚未发送。'); },
    'confirm-submit': submitConfirm,
    stage: (control) => stageInfo(control.dataset.value),
  };
  document.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    if (control && !control.disabled) actions[control.dataset.action]?.(control);
    if (!event.target.closest('.menu-anchor')) { $('more-menu').hidden = true; $('more-button').setAttribute('aria-expanded', 'false'); }
  });
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  $('code-search').addEventListener('input', () => searchCode(false));
  $('code-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); searchCode(true); } });
  $('source-editor').addEventListener('input', (event) => { state.draft = event.target.value; $('cursor-status').textContent = `${state.draft.split('\n').length} 行 · 尚未保存`; });
  $('drawer-body').addEventListener('input', (event) => { if (event.target.dataset.issue !== undefined) state.issues[Number(event.target.dataset.issue)] = event.target.value; });
  $('route-select').addEventListener('change', (event) => { state.route = event.target.value; if (state.runtime === 'running') mountPreview(); });
  $('chat-form').addEventListener('submit', (event) => {
    event.preventDefault(); const text = $('chat-input').value.trim(); if (!text) { $('chat-input').focus(); return; }
    const user = document.createElement('article'); user.className = 'message user-message'; user.innerHTML = '<div class="message-author">你 · 模拟输入</div><p>' + escapeHTML(text).replace(/\n/g, '<br>') + '</p>';
    const response = document.createElement('article'); response.className = 'message assistant-message'; response.innerHTML = '<div class="message-author"><span class="ai-emblem">E</span>EADP 助手 · 设计占位</div><p>已展示这条模拟消息。实际产品将在原生会话中继续处理；本页没有调用模型，也不会自动修改源码。</p>';
    $('chat-scroll').append(user, response); $('chat-input').value = ''; $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight;
  });
  $('chat-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); } });
  window.addEventListener('message', (event) => {
    // The sandbox has an opaque origin. Only the owned iframe window may update the design state.
    if (event.source !== $('business-preview').contentWindow || event.data?.source !== 'eadp-prototype-demo') return;
    const data = event.data;
    if (data.type === 'route' && ['orders', 'approvals', 'suppliers'].includes(data.route)) { state.route = data.route; $('route-select').value = data.route; }
    if (data.type === 'orders-updated' && Array.isArray(data.orders)) state.businessOrders = data.orders;
    if (data.type === 'save-failure-consumed') state.failSave = false;
    if (data.type === 'escape-preview') { $('preview-pane').classList.remove('preview-expanded'); document.querySelector('[data-action="fullscreen"]').setAttribute('aria-pressed', 'false'); }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if ($('unsaved-dialog').open) { state.pendingAction = null; return; }
      if (state.drawer) closeDrawer();
      else if ($('preview-pane').classList.contains('preview-expanded')) $('preview-pane').classList.remove('preview-expanded');
      else { if (!$('more-menu').hidden) $('more-button').focus(); $('more-menu').hidden = true; $('more-button').setAttribute('aria-expanded', 'false'); }
    }
    if (event.key === 'Tab' && state.drawer) {
      const focusable = [...$('drawer').querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]')].filter((node) => !node.hidden);
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
    }
    const tab = event.target.closest('.mode-switch [role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const mode = event.key === 'Home' ? 'preview' : event.key === 'End' ? 'code' : state.mode === 'preview' ? 'code' : 'preview'; guardUnsaved(() => { setMode(mode); $(mode + '-tab').focus(); }); }
    if (event.target.closest('#more-menu') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const items = [...$('more-menu').querySelectorAll('button')]; const current = items.indexOf(document.activeElement); const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[index]?.focus(); }
  });
  window.addEventListener('beforeunload', (event) => { if (state.editing && $('source-editor').value !== files[state.activeFile]?.text) { event.preventDefault(); event.returnValue = ''; } });
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => { if ((lastWidth > 1100) !== (window.innerWidth > 1100)) state.aiCollapsed = window.innerWidth <= 1100; if ((lastWidth > 800) !== (window.innerWidth > 800)) state.treeCollapsed = window.innerWidth <= 800; lastWidth = window.innerWidth; renderChrome(); });
  renderChrome(); renderEditor(); mountPreview();
})();
