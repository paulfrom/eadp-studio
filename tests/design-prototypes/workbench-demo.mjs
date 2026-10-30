/** Offline design interaction checks; pass an existing happy-dom module path, never installs dependencies. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const modulePath = process.argv[2];
if (!modulePath) throw new Error('Usage: node tests/design-prototypes/workbench-demo.mjs <existing happy-dom lib/index.js>');
let Window;
try { ({ Window } = await import(pathToFileURL(resolve(modulePath)).href)); }
catch (cause) { throw new Error('Existing happy-dom module is unavailable. Pass its installed lib/index.js path; this check does not install or fetch dependencies.', { cause }); }
const window = new Window({ settings: { disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
window.structuredClone = structuredClone;
const document = window.document;
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const click = (action, value) => {
  const button = document.querySelector(`[data-action="${action}"]${value ? `[data-value="${value}"]` : ''}`);
  assert.ok(button, `Missing ${action} ${value || ''}`); button.click();
};
const text = () => document.getElementById('drawer-body').textContent;
try {
  document.write((await readFile('docs/dseign/原型交互工作台.html', 'utf8')).replace(/<script[^>]+src=[^>]+><\/script>/g, ''));
  document.getElementById('unsaved-dialog').showModal = function () { this.open = true; };
  document.getElementById('unsaved-dialog').close = function () { this.open = false; };
  window.eval(await readFile('docs/dseign/prototype-workbench.js', 'utf8'));
  check(document.getElementById('task-label').textContent.includes('订单体验完善'), 'Initial selected item');
  check(!document.body.textContent.includes('工程检查'), '工程检查已移除');
  check(document.getElementById('check-button') === null, '工程检查按钮已移除');
  check(document.querySelectorAll('[data-action="device"]').length === 0, '设备宽度切换已移除');
  check(document.querySelector('.preview-footnote').textContent.includes('自适应桌面'), '预览底栏显示自适应桌面');
  check(!document.querySelector('.preview-footnote').textContent.includes('合成业务数据'), '预览底栏不再提示合成业务数据');
  check(document.querySelector('#ai-panel .transcript') !== null, 'AI 面板使用统一对话容器');
  check(document.querySelector('#ai-panel .decide .decision') !== null, 'AI 面板包含需要你决定区块');
  check(document.querySelector('#ai-panel .proposal') !== null, 'AI 面板包含变更提议卡片');
  check(document.querySelector('#ai-panel .composer-box') !== null, 'AI 面板使用统一输入条');
  document.querySelector('#ai-panel .decision[data-key="orders"] .choice').click();
  check(document.getElementById('decision-dock').hidden === false, '决策选择后出现插入条');
  document.getElementById('insert-decisions').click();
  check(document.getElementById('chat-input').value.includes('我的选择'), '决策回答写入输入草稿');
  document.getElementById('chat-input').value = '';
  click('drawer', 'tasks'); check(text().includes('待开始'), 'Queue visible');
  click('item-switch', 'DEMO-02'); check(document.getElementById('task-label').textContent.includes('供应商查询优化'), 'Switch item');
  check(!document.getElementById('chat-scroll').textContent.includes('排队实现指令（模拟发送）'), 'Viewing does not send');
  click('drawer', 'tasks'); click('item-continue');
  check(document.querySelectorAll('.user-message').length === 1, 'First queued instruction sent once');
  click('item-pause'); click('item-continue');
  check(document.querySelectorAll('.user-message').length === 1, 'Continue does not resend first instruction');
  click('item-switch', 'DEMO-01');
  check(document.getElementById('chat-scroll').textContent.includes('3 项需求'), 'Original conversation restored');
  click('drawer', 'tasks'); click('item-continue'); check(text().includes('请先暂停'), 'Single running item');
  const instruction = document.getElementById('queue-instruction'); instruction.value = '实现审批意见筛选';
  click('item-enqueue'); check(text().includes('陈明'), 'Conflict identifies owner');
  check(instruction.value === '实现审批意见筛选', 'Conflict retains instruction');
  check(document.querySelectorAll('.item-row').length === 2, 'Conflict creates no item');
  click('item-enqueue-retry'); check(document.querySelectorAll('.item-row').length === 3, 'Released claim creates queue item');
  check(text().includes('首次指令保留、尚未发送'), 'Other running item keeps new instruction pending');
  click('item-switch', 'DEMO-02'); click('drawer', 'tasks'); click('item-pause');
  check(!text().includes('当前执行：'), 'Pause does not auto dispatch queue');
  click('item-switch', 'DEMO-03'); click('drawer', 'tasks'); click('item-continue');
  check(document.getElementById('chat-scroll').textContent.includes('实现审批意见筛选'), 'Queued original instruction delivered');
  click('item-pause'); click('item-switch', 'DEMO-01'); click('drawer', 'tasks'); click('item-expand');
  check(text().includes('原开发范围、源码和会话保留'), 'Expansion failure preserves scene');
  click('item-expand-retry'); check(text().includes('本人事项'), 'Same user claim conflict remains exclusive');
  click('close-drawer'); click('open-file', 'page'); click('edit-file');
  const editor = document.getElementById('source-editor'); const original = editor.value; editor.value += '\n// scene-one';
  click('drawer', 'tasks'); click('item-switch', 'DEMO-02');
  check(document.getElementById('unsaved-dialog').open, 'Switch protects unsaved editing');
  click('unsaved-save');
  click('open-file', 'page'); click('edit-file'); check(document.getElementById('source-editor').value === original, 'Item files isolated');
  click('cancel-edit'); click('drawer', 'tasks'); click('item-switch', 'DEMO-01'); click('open-file', 'page'); click('edit-file');
  check(document.getElementById('source-editor').value.endsWith('// scene-one'), 'Saved source restored');
  click('cancel-edit'); click('drawer', 'diagnostics');
  check(text().includes('scene-DEMO-01') && text().includes('非真实 Git SHA') && text().includes('未连接；未知'), 'Diagnostic source and scene are explicit simulations');
  // Independent samples cover expansion recovery and first-send dispatch without queued work.
  for (const scenario of ['expansion', 'direct-dispatch']) {
    const sample = new Window({ settings: { disableJavaScriptFileLoading: true, disableIframePageLoading: true } });
    sample.structuredClone = structuredClone;
    try {
      sample.document.write((await readFile('docs/dseign/原型交互工作台.html', 'utf8')).replace(/<script[^>]+src=[^>]+><\/script>/g, ''));
      sample.eval(await readFile('docs/dseign/prototype-workbench.js', 'utf8'));
      const tap = (action, value) => sample.document.querySelector(`[data-action="${action}"]${value ? `[data-value="${value}"]` : ''}`).click();
      tap('drawer', 'tasks');
      if (scenario === 'expansion') {
        const before = sample.document.getElementById('chat-scroll').textContent;
        tap('item-expand'); tap('item-expand-retry');
        check(sample.document.getElementById('task-context').textContent.includes('REQ-0013'), 'Expansion recovery updates claims');
        check(sample.document.getElementById('chat-scroll').textContent === before, 'Expansion never sends implementation message');
      } else {
        sample.document.getElementById('queue-instruction').value = '实现审批筛选';
        tap('item-enqueue-retry');
        check(sample.document.getElementById('task-label').textContent.includes('正在执行'), 'First send starts immediately when idle');
        check(sample.document.querySelectorAll('.user-message').length === 1, 'Direct dispatch sends once');
      }
    } finally { await sample.happyDOM.abort(); await sample.close(); }
  }
  console.log(`Offline DOM: ${checks} passed. No browser layout, real model, Host, collaboration service, Git or persistence exercised.`);
} finally { await window.happyDOM.abort(); await window.close(); }
