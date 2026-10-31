import css from '../studio.module.css'

/** The material page keeps project context and reload beside its return action. */
export function MaterialPageHeader({ name, projectName, connected, busy, onBack, onReload }: {
  name: string; projectName: string | undefined; connected: boolean; busy: boolean;
  onBack(): void; onReload(): void;
}) {
  return <header className={css.materialPageHeader} aria-label="材料工作区工具栏">
    <button type="button" className={css.materialBack} onClick={onBack}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M19 12H5m7-7-7 7 7 7" /></svg>返回{name}列表</button>
    <span className={css.materialProject}>项目 <strong title={projectName}>{projectName}</strong></span>
    <span className={css.materialPresence} role="status" data-state={busy ? 'busy' : connected ? 'connected' : 'disconnected'}><i />{busy ? '正在处理' : connected ? '协同工作台已登录' : '等待连接'}</span>
    <button type="button" className={css.materialReload} disabled={busy} aria-label="重新读取草稿" title="重新读取草稿" onClick={onReload}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6" /></svg></button>
  </header>
}
