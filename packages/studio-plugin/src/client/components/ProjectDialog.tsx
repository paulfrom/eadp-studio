import { useEffect, useRef, useState } from 'react'
import type { NamespaceView, ProjectView } from '@eadp/contracts'
import type { LocalProject, StudioCommand } from '../../shared/studio.ts'
import css from '../studio.module.css'

type ProjectCommand = Extract<StudioCommand, { action: 'createProject' | 'openProject' }>
export function ProjectDialog({ busy, projects, namespaces, defaultDirectory, localProjects, pickDirectory, onClose, onSubmit }: { defaultDirectory?: string; localProjects: LocalProject[]; pickDirectory(): Promise<string | null>; busy: boolean; projects: ProjectView[]; namespaces: NamespaceView[]; onClose(): void; onSubmit(command: ProjectCommand): Promise<void> }) {
  const [workspaceDirectory, setWorkspaceDirectory] = useState(''), [picking, setPicking] = useState(false), [failure, setFailure] = useState('')
  const ref = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(''), [repositoryPath, setRepositoryPath] = useState(''), [namespaceId, setNamespaceId] = useState('')
  const [mode, setMode] = useState<'open' | 'create'>('open'), [projectId, setProjectId] = useState('')
  const registered = mode === 'open' ? localProjects.find(project => project.id === projectId) : undefined
  const location = !registered && workspaceDirectory ? { workspaceDirectory } : {}
  useEffect(() => { const element = ref.current!; element.showModal(); return () => element.close() }, [])
  const selectedNamespace = namespaceId || String(namespaces[0]?.id ?? '')
  return <dialog ref={ref} className={css.dialog} onCancel={onClose} aria-labelledby="project-dialog-title"><form onSubmit={event => {
    event.preventDefault()
    void onSubmit(mode === 'create' ? { action: 'createProject', name, namespaceId: Number(selectedNamespace), path: repositoryPath, ...location } : { action: 'openProject', projectId, ...location })
  }}><header><div><p className={css.eyebrow}>PROJECT WORKSPACE</p><h2 id="project-dialog-title">开始一个项目</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></header>
    <p>项目由协同后台登记并分配访问权限，材料与原型保存在项目 GitLab 仓库中。</p>
    <label>操作<select value={mode} onChange={event => setMode(event.target.value as 'open' | 'create')}><option value="open">打开已有项目</option><option value="create">新建项目</option></select></label>
    {mode === 'open' ? <><label>可用项目<select required value={projectId} onChange={event => setProjectId(event.target.value)}><option value="" disabled>选择后台登记的项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.namespacePath}{project.initializationStatus === 'pending' ? '（待初始化，可继续）' : ''}</option>)}</select></label>{projects.length === 0 && <p>当前账号还没有可用项目。</p>}</> : <>
      <label>项目名称<input required autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={200} placeholder="例如：采购协同工作台" /></label>
      <label>群组<select required value={selectedNamespace} onChange={event => setNamespaceId(event.target.value)}><option value="" disabled>{namespaces.length ? '选择项目群组' : '正在加载可建仓群组…'}</option>{namespaces.map(namespace => <option key={namespace.id} value={namespace.id}>{namespace.fullPath} · {namespace.name}</option>)}</select></label>
      <label>仓库路径<input required value={repositoryPath} onChange={event => setRepositoryPath(event.target.value)} maxLength={100} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="例如：procurement-studio" /></label>
      <p>后台创建私有仓库并授予当前用户权限；本机使用已配置的个人 Git 凭据推送首次提交。</p>
    </>}
    <label>项目文件夹<input readOnly value={registered?.workspaceDirectory ?? workspaceDirectory} placeholder={defaultDirectory ? `默认存放在 ${defaultDirectory} 下的项目文件夹` : '正在读取默认位置…'} /></label>
    <button type="button" disabled={busy || picking || !!registered} onClick={() => { setPicking(true); setFailure(''); void pickDirectory().then(directory => { if (directory !== null) setWorkspaceDirectory(directory) }).catch(error => setFailure(error instanceof Error ? error.message : '无法选择文件夹')).finally(() => setPicking(false)) }}>{picking ? '正在选择…' : '选择文件夹'}</button>
    {!registered && workspaceDirectory && <button type="button" onClick={() => setWorkspaceDirectory('')}>使用默认位置</button>}
    <p>{registered ? '继续使用本机已登记的项目位置' : '选择空文件夹，材料、原型和本机工作现场保存在这里，程序工具和缓存单独保存。'}</p>
    {failure && <p role="alert">{failure}</p>}
    <footer><button type="button" onClick={onClose}>取消</button><button className={css.primary} disabled={busy || picking || (mode === 'open' ? !projectId : !selectedNamespace)}>{busy ? '正在处理…' : mode === 'open' ? '打开项目' : '创建项目'}</button></footer>
  </form></dialog>
}
