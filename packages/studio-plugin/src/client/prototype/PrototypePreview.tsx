import { useCallback, useRef, useState } from 'react'
import { PrototypeCanvas, type PrototypeCanvasIdentity } from './PrototypeCanvas.tsx'
import css from './preview.module.css'
import { PrototypeIcon as Icon } from './PrototypeIcon.tsx'

export interface PrototypePreviewProps {
  identity?: PrototypeCanvasIdentity | undefined
  visible: boolean
  route?: string
  onNavigate?(route: string): Promise<void>
  onRefresh?(): Promise<void>
  externalUrl?: string | undefined
}

/** Preview controls delegate navigation to the Host; only layout is managed here. */
export function PrototypePreview({ identity, visible, route = '/', onNavigate, onRefresh, externalUrl }: PrototypePreviewProps) {
  const navigation = useRef<((request: { path?: string; reload?: boolean }) => Promise<void>)>()
  const registerNavigation = useCallback((handler?: (request: { path?: string; reload?: boolean }) => Promise<void>) => { navigation.current = handler }, [])
  const navigate = async (request: { path?: string; reload?: boolean }) => { if (!navigation.current) throw new Error('预览尚未就绪'); await navigation.current(request) }
  onNavigate ??= identity ? path => navigate({ path }) : undefined
  onRefresh ??= identity ? () => navigate({ reload: true }) : undefined
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop')
  const [expanded, setExpanded] = useState(false)
  const [path, setPath] = useState(route)
  const [error, setError] = useState('')
  const invoke = async (action?: () => Promise<void>) => {
    try { await action?.(); setError('') } catch (error) { setError(error instanceof Error ? error.message : '预览操作失败') }
  }
  return <section hidden={!visible} className={`${css.preview} ${expanded ? css.expanded : ''}`} aria-label="项目预览">
    <div className={css.toolbar}>
      <span className={css.runtime}><i data-running={!!identity} />{identity ? '预览运行中' : '预览未运行'}</span>
      <form className={css.route} onSubmit={event => { event.preventDefault(); void invoke(onNavigate ? () => onNavigate(path) : undefined) }}>
        <input aria-label="预览页面" value={path} disabled={!identity || !onNavigate} title={onNavigate ? '输入页面路径后按 Enter' : '当前桌面暂未提供页面导航接口'} onChange={event => setPath(event.target.value)} />
      </form>
      <button aria-label="刷新预览页面" title={onRefresh ? '刷新预览页面' : '当前桌面暂未提供刷新接口'} disabled={!identity || !onRefresh} onClick={() => void invoke(onRefresh)}><Icon name="refresh" /></button>
      <div className={css.spacer} />
      <div className={css.devices} aria-label="预览宽度">{(['desktop', 'tablet', 'mobile'] as const).map(value => <button key={value} aria-label={value === 'desktop' ? '桌面宽度' : value === 'tablet' ? '平板宽度 768 像素' : '手机宽度 390 像素'} aria-pressed={device === value} onClick={() => setDevice(value)}><svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><rect x={value === 'desktop' ? 2 : value === 'tablet' ? 4 : 7} y={3} width={value === 'desktop' ? 20 : value === 'tablet' ? 16 : 10} height={value === 'desktop' ? 14 : 18} rx={2} />{value === 'desktop' && <path d="M8 21h8M12 17v4" />}</svg></button>)}</div>
      <button aria-label="切换预览全屏" aria-pressed={expanded} onClick={() => setExpanded(value => !value)}><Icon name="maximize" /></button>
      {identity && externalUrl && <a aria-label="在新窗口打开预览" title="在新窗口打开" href={externalUrl} target="_blank" rel="noreferrer"><Icon name="external" /></a>}
    </div>
    {error && <p role="alert">{error}</p>}
    <div className={css.canvas}><div className={css.frame} style={{ width: device === 'desktop' ? '100%' : device === 'tablet' ? 768 : 390 }}>
      {identity ? <PrototypeCanvas identity={identity} visible={visible} registerNavigation={registerNavigation} /> : <div className={css.empty}>运行项目后，在这里核对页面和业务流程。</div>}
    </div></div>
    <footer className={css.footnote}><span>合成业务数据 · 仅用于需求核对</span><span>{device === 'desktop' ? '自适应桌面' : device === 'tablet' ? '768 px' : '390 px'}</span></footer>
  </section>
}
