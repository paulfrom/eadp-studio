/** Offline header CTA checks for the scenario and requirement design drafts; pass an existing jsdom module path, never installs dependencies. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const modulePath = process.argv[2];
if (!modulePath) throw new Error('Usage: node tests/design-prototypes/check-prototype-headers.mjs <existing jsdom lib/api.js>');
let JSDOM;
try { ({ JSDOM } = await import(pathToFileURL(resolve(modulePath)).href)); }
catch (cause) { throw new Error('Existing jsdom module is unavailable. Pass its installed lib/api.js path; this check does not install or fetch dependencies.', { cause }); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };

/**
 * Loads one design draft into its own DOM, silencing scrollIntoView and collecting runtime errors.
 * The caller owns the returned window and must close it.
 */
function load(html) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const errors = [];
  dom.window.addEventListener('error', event => errors.push(String(event.error || event.message)));
  const q = selector => dom.window.document.querySelector(selector);
  return { dom, q, errors };
}

async function scenarioHeader() {
  const { dom, q, errors } = load(await readFile('docs/dseign/项目场景编辑-AI交互优化.html', 'utf8'));
  try {
    await wait(50);
    check(q('#stageCta').closest('.panel-head') !== null, '场景 · CTA 在对话头');
    check(dom.window.document.querySelector('.actionbar') === null && dom.window.document.querySelector('.state-line') === null, '场景 · 头部无独立动作条');
    check(q('#stageCta').textContent.trim().startsWith('审阅 9 处变更'), `场景 · 初始 CTA（实际：${q('#stageCta').textContent.trim()}）`);
    check(q('#stageCta').hidden === false, '场景 · 初始可见');

    q('#stageCta').click();
    q('#acceptBtn').click();
    check(q('#stageCta').closest('.panel-head') !== null && q('#stageCta').hidden === false, '场景 · 写入后仍在头部');
    check(q('#stageCta').textContent.trim().startsWith('处理 1 项阻断'), `场景 · 写入后 CTA（实际：${q('#stageCta').textContent.trim()}）`);

    q('#stageCta').click();
    check(q('#gateEvidenceState').textContent.includes('提醒'), '场景 · 缺正式依据只提醒');
    q('#gateBusinessAction').click();
    q('.decision[data-key="refund"] .choice').click();
    q('.decision[data-key="goods"] .choice').click();
    q('#stageCta').click();
    q('#confirmBtn').click();
    await wait(2700);
    check(q('#stageCta').hidden === true, '场景 · 确认后 CTA 隐藏');
    check(q('#confirmedBar').hidden === false, '场景 · 确认横幅');
    check(q('#toastUndo').hidden === true, '场景 · 确认后 toast 无撤销');
    await wait(2400);
    check(q('#consResult').hidden === false, '场景 · 自动一致性');
    check(errors.length === 0, `场景 · 无报错（${errors.join(' ; ')}）`);
  } finally { dom.window.close(); }
}

async function requirementHeader() {
  const { dom, q, errors } = load(await readFile('docs/dseign/需求管理-AI交互优化.html', 'utf8'));
  try {
    await wait(50);
    check(q('#stageCta').closest('.panel-head') !== null, '需求 · CTA 在对话头');
    check(q('#stageCta').textContent.trim().startsWith('审阅 6 处变更'), `需求 · 初始 CTA（实际：${q('#stageCta').textContent.trim()}）`);
    q('#stageCta').click();
    q('#acceptBtn').click();
    check(q('#stageCta').textContent.trim().startsWith('处理 2 项阻断'), `需求 · 写入后 CTA（实际：${q('#stageCta').textContent.trim()}）`);
    q('#stageCta').click();
    check(q('#confirmSheet').open === true, '需求 · 清单可打开');
    q('#cancelConfirm').click();
    check(q('#confirmSheet').open === false, '需求 · 清单可关闭');
    check(q('#reviseBtn') !== null, '需求 · 文档修订入口存在');
    check(errors.length === 0, `需求 · 无报错（${errors.join(' ; ')}）`);
  } finally { dom.window.close(); }
}

await scenarioHeader();
await requirementHeader();
console.log(`Offline headers: ${checks} passed. No browser layout, real model, Host, collaboration service, Git or persistence exercised.`);
