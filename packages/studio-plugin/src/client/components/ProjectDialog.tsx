import { useEffect, useRef, useState } from 'react'
import type { NamespaceView, ProjectView } from '@eadp/contracts'
import type { StudioCommand } from '../../shared/studio.ts'
import css from '../studio.module.css'

type ProjectCommand = Extract<StudioCommand, { action: 'createProject' | 'openProject' }>
export function ProjectDialog({ busy, projects, namespaces, onClose, onSubmit }: { busy: boolean; projects: ProjectView[]; namespaces: NamespaceView[]; onClose(): void; onSubmit(command: ProjectCommand): Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(''), [repositoryPath, setRepositoryPath] = useState(''), [namespaceId, setNamespaceId] = useState('')
  const [mode, setMode] = useState<'open' | 'create'>('open'), [projectId, setProjectId] = useState('')
  useEffect(() => { const element = ref.current!; element.showModal(); return () => element.close() }, [])
  const selectedNamespace = namespaceId || String(namespaces[0]?.id ?? '')
  return <dialog ref={ref} className={css.dialog} onCancel={onClose} aria-labelledby="project-dialog-title"><form onSubmit={event => {
    event.preventDefault()
    void onSubmit(mode === 'create' ? { action: 'createProject', name, namespaceId: Number(selectedNamespace), path: repositoryPath } : { action: 'openProject', projectId })
  }}><header><div><p className={css.eyebrow}>PROJECT WORKSPACE</p><h2 id="project-dialog-title">开始一个项目</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></header>
    <p>项目由协同后台登记并分配访问权限，材料与原型保存在项目 GitLab 仓库中。</p>
    <label>操作<select value={mode} onChange={event => setMode(event.target.value as 'open' | 'create')}><option value="open">打开已有项目</option><option value="create">新建项目</option></select></label>
    {mode === 'open' ? <><label>可用项目<select required value={projectId} onChange={event => setProjectId(event.target.value)}><option value="" disabled>选择后台登记的项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.namespacePath}{project.initializationStatus === 'pending' ? '（待初始化，可继续）' : ''}</option>)}</select></label>{projects.length === 0 && <p>当前账号还没有可用项目。</p>}</> : <>
      <label>项目名称<input required autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={200} placeholder="例如：采购协同工作台" /></label>
      <label>群组<select required value={selectedNamespace} onChange={event => setNamespaceId(event.target.value)}><option value="" disabled>选择项目群组</option>{namespaces.map(namespace => <option key={namespace.id} value={namespace.id}>{namespace.fullPath} · {namespace.name}</option>)}</select></label>
      <label>仓库路径<input required value={repositoryPath} onChange={event => setRepositoryPath(event.target.value)} maxLength={100} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="例如：procurement-studio" /></label>
      <p>后台创建私有仓库并授予当前用户权限；本机使用已配置的个人 Git 凭据推送首次提交。</p>
    </>}
    <footer><button type="button" onClick={onClose}>取消</button><button className={css.primary} disabled={busy || (mode === 'open' ? !projectId : !selectedNamespace)}>{busy ? '正在处理…' : mode === 'open' ? '打开项目' : '创建项目'}</button></footer>
  </form></dialog>
}
