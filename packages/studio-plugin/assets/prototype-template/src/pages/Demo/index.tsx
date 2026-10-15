import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, Money, MoneyInput } from '@ead/suid';
import { setDemoMode } from '@/mock/handlers';
import type { DemoMode } from '@/mock/handlers';
import type { DemoRecord } from '@/mock/fixtures';
import { listRecords, resetRecords, saveRecord } from './service';

export default function Demo() {
  const [records, setRecords] = useState<DemoRecord[]>([]);
  const [draft, setDraft] = useState<DemoRecord>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load(mode: DemoMode = 'normal') {
    setDemoMode(mode);
    setLoading(true);
    setError('');
    try { setRecords(await listRecords()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请求失败'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setError('');
    try {
      const saved = await saveRecord(draft);
      setRecords((current) => current.map((record) => record.id === saved.id ? saved : record));
      setDraft(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败'); }
    finally { setSaving(false); }
  }

  return (
    <main className="prototype-page">
      <h1>合成数据演示</h1>
      <p className="intro">独立静态原型 · 全部数据在当前页面内存中，刷新或重置后恢复样例。</p>
      <Alert type="info" showIcon message="使用本地合成数据，不连接业务后台或主应用。" />
      <div className="toolbar" aria-label="演示场景">
        <Button onClick={() => { void load(); }} disabled={loading || saving}>正常列表</Button>
        <Button onClick={() => { void load('empty'); }} disabled={loading || saving}>空数据</Button>
        <Button onClick={() => { void load('error'); }} disabled={loading || saving}>请求错误</Button>
        <Button onClick={() => { setDemoMode('save-error'); }} disabled={saving}>下次保存失败</Button>
        <Button onClick={async () => { setRecords(await resetRecords()); setDraft(undefined); setError(''); }} disabled={loading || saving}>重置演示</Button>
      </div>
      {error && <Alert role="alert" type="error" showIcon message={error} />}
      <section aria-busy={loading} aria-live="polite">
        {loading ? <p>正在加载合成数据…</p> : records.length === 0 ? <p>暂无样例，选择正常列表恢复。</p> : (
          <ul className="record-list">
            {records.map((record) => (
              <li className="record" key={record.id}>
                <span className="record-name">{record.name}</span>
                <Money value={record.amount} />
                <Button onClick={() => setDraft({ ...record })} disabled={saving}>查看 / 编辑</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {draft && (
        <section className="editor" aria-label="样例详情">
          <h2>样例详情 · {draft.id}</h2>
          <label>名称<Input value={draft.name} disabled={saving} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>金额<MoneyInput value={draft.amount} disabled={saving} precision={2} precisionType="round" onChange={(amount) => setDraft({ ...draft, amount: Number(amount ?? 0) })} /></label>
          <div className="toolbar">
            <Button type="primary" loading={saving} onClick={() => { void save(); }}>保存</Button>
            <Button disabled={saving} onClick={() => setDraft(undefined)}>取消编辑</Button>
          </div>
        </section>
      )}
    </main>
  );
}
