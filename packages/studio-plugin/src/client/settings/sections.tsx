/** Studio sections inside the host settings dialog: registered on `settings.section`, one entry per concern. */

import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StudioCommand, StudioReply, StudioState } from '../../shared/studio.ts'
import type { ThemeFace } from '../theme.ts'
import studioCss from '../studio.module.css'
import css from './sections.module.css'
import { ScenarioTemplateSettings } from './ScenarioTemplateSettings.tsx'

/** Faces the Studio settings sections act through (wired from the client context). */
export interface StudioSettingsFaces {
  call(command: StudioCommand): Promise<StudioReply>
  theme: ThemeFace
}

type SectionProps = PropsRuntime<'settings.section'> & StudioSettingsFaces

const idleState = (): StudioState => ({ connected: false, projects: [], availableProjects: [], namespaces: [], projectInitializations: [], drafts: [], tasks: [], candidates: [], pending: [], reviews: [] })

/** The workbench projection a section needs: fetched on mount, refreshed on demand. A failed fetch is not
 *  evidence of being signed out, so non-LOGIN_REQUIRED failures keep the last projection and surface `loadError`. */
function useStudioState(call: StudioSettingsFaces['call']): { state: StudioState; setState(next: StudioState): void; refresh(): void; loadError: string } {
  const [state, setState] = useState<StudioState>(idleState)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    void call({ action: 'state' }).then(result => {
      if (cancelled) return
      if (result.ok) { setState(result.state); setLoadError('') }
      else if (result.code === 'LOGIN_REQUIRED') { setState(idleState()); setLoadError('') }
      else setLoadError(result.message)
    }).catch(error => { if (!cancelled) setLoadError(error instanceof Error ? error.message : '工作台状态获取失败') })
    return () => { cancelled = true }
  }, [call, attempt])
  // Login/logout elsewhere (the workbench panel, another dialog session) announce
  // themselves; a refetch here heals a section that mounted during a failed fetch.
  useEffect(() => {
    const refresh = () => setAttempt(value => value + 1)
    window.addEventListener('eadp:studio-state-changed', refresh)
    return () => window.removeEventListener('eadp:studio-state-changed', refresh)
  }, [])
  return { state, setState, refresh: () => setAttempt(value => value + 1), loadError }
}

/** Tell the workbench panel to re-poll immediately instead of waiting for its next tick. */
function notifyWorkbench(): void {
  window.dispatchEvent(new CustomEvent('eadp:studio-state-changed'))
}

type IconName = 'monitor' | 'moon' | 'sun' | 'lock' | 'logout' | 'info'
const paths: Record<IconName, string> = {
  monitor: 'M3 3h18v12H3zM8 21h8M12 17v4',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  lock: 'M6 11h12v9H6zM9 11V7a3 3 0 016 0v4',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 8v5M12 16.5h.01',
}
function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg className={className ?? css.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

/** Section descriptors registered by the client half; ids must not collide with native sections. */
export const settingsSections: Array<{ id: string; order: number; label: string; component: (props: SectionProps) => ReactNode }> = [
  { id: 'studio-collab', order: -9, label: '协同账号', component: CollabAccountSection },
  { id: 'studio-scenario-templates', order: 4, label: '场景模板', component: ScenarioTemplateSection },
  { id: 'studio-appearance', order: 5, label: '外观', component: AppearanceSection },
  { id: 'studio-connection', order: 6, label: '协同连接', component: ConnectionSection },
  { id: 'studio-about', order: 200, label: '关于', component: AboutSection },
]

function Section({ children }: { children: ReactNode }) {
  return <div className={`${studioCss.settingsScope} ${css.section}`}>{children}</div>
}

function CollabAccountSection(props: SectionProps) {
  const { state, setState, loadError, refresh } = useStudioState(props.call)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const account = state.account
  useEffect(() => { if (error) setPassword('') }, [error])
  const submitLogin = (event: FormEvent) => {
    event.preventDefault()
    const submitted = password
    setPassword('')
    setBusy(true)
    void props.call({ action: 'login', username, password: submitted }).then(result => {
      if (result.ok) { setState(result.state); setUsername(''); setError(''); notifyWorkbench() }
      else setError(result.message)
    }).catch(err => setError(err instanceof Error ? err.message : '登录未完成，请重新提交')).finally(() => setBusy(false))
  }
  const logout = () => {
    setBusy(true)
    void props.call({ action: 'logout' }).then(result => {
      if (result.ok) { setState(idleState()); notifyWorkbench() }
    }).catch(() => { /* 登出失败保持现状，面板轮询会反映真实状态 */ }).finally(() => setBusy(false))
  }
  return <Section>
    {!account && loadError ? <>
      <p className={css.sectionIntro}>协同工作台状态暂时无法确认；请重试，或检查本机工作台服务是否正常。</p>
      <div className={css.identityCard}>
        <span className={css.identityAvatar}>!</span>
        <div><div className={css.identityName}>无法获取登录状态</div><div className={css.identityMeta}>{loadError}</div></div>
        <button className={css.ghostBtn} onClick={refresh}>重试</button>
      </div>
    </> : account ? <>
      <p className={css.sectionIntro}>协同身份用于登录工作台、校验项目访问权限；Git 推送仍使用本机 Git 凭据。</p>
      <div className={css.identityCard}>
        <span className={css.identityAvatar}>{account.name.slice(0, 1) || '@'}</span>
        <div><div className={css.identityName}>{account.name}</div><div className={css.identityMeta}>@{account.username} · 协同用户 {account.id}<br />绑定 GitLab @{account.gitlabUsername}</div></div>
        <span className={`${css.chip} ${css.ok}`}>已登录</span>
      </div>
      <div className={css.group}>
        <h3 className={css.groupTitle}>登录状态</h3>
        <div className={css.kvBlock}>
          <div className={css.kv}><span className={css.kvK}>登录缓存</span><span className={css.kvV}><span className={`${css.badge} ${css.accent}`}>本机安全存储 · 90 天</span></span></div>
          <div className={css.kv}><span className={css.kvK}>本机凭据</span><span className={css.kvV}>系统安全存储 · 会话令牌</span></div>
          <div className={css.kv}><span className={css.kvK}>Git 凭据</span><span className={css.kvV}>本机独立管理</span></div>
        </div>
        <div className={css.settingRow}>
          <div className={css.settingText}><div className={css.settingTitle}>退出登录</div><div className={css.settingDesc}>撤销当前协同会话并清除本机缓存；此操作不影响本机 Git 凭据。</div></div>
          <button className={css.dangerBtn} disabled={busy} onClick={logout}><Icon name="logout" />退出登录</button>
        </div>
      </div>
      <div className={css.note}><Icon name="info" /><span>更换工作站后使用同一账号重新登录，项目与占用状态会从协同后端恢复；本机不保存密码，也不缓存项目正文。</span></div>
    </> : <>
      <p className={css.sectionIntro}>使用协同账号登录工作台，项目访问权限由后台管理；登录状态在本机系统安全存储中缓存，最长 90 天。</p>
      <div className={`${css.identityCard} ${css.signedOut}`}>
        <span className={css.identityAvatar}>?</span>
        <div><div className={css.identityName}>未登录协同工作台</div><div className={css.identityMeta}>登录后查看可用项目与当前占用。</div></div>
        <span className={css.chip}>未登录</span>
      </div>
      <form className={css.loginForm} onSubmit={submitLogin} noValidate>
        <div className={css.field}><label htmlFor="studio-login-username">用户名</label><input id="studio-login-username" required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="studioAdmin" maxLength={100} /></div>
        <div className={css.field}><label htmlFor="studio-login-password">密码</label><input id="studio-login-password" required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="••••••••" maxLength={200} /></div>
        {error && <p className={css.inlineError} role="alert">{error}</p>}
        <button className={css.primaryBtn} type="submit" disabled={busy}>{busy ? '正在登录…' : '登录协同工作台'}</button>
        <p className={css.formNote}>账号与密码仅发送到固定协同后端；登录状态在本机系统安全存储中缓存，本机不写入密码。</p>
      </form>
      <div className={css.loginSep}>登录状态保存策略</div>
      <div className={css.note}><Icon name="lock" /><span>会话令牌在本机系统安全存储中缓存，默认最长 90 天；后端会话同步持久保存，退出登录会同时撤销远端会话。</span></div>
    </>}
  </Section>
}

function AppearanceSection(props: SectionProps) {
  const snapshot = useSyncExternalStore(props.theme.subscribe, props.theme.getSnapshot)
  const resolved = (snapshot.preference === 'system' ? snapshot.active.colorScheme : snapshot.preference) === 'dark' ? '深色' : '浅色'
  const following = snapshot.preference === 'system'
  return <Section>
    <p className={css.sectionIntro}>主题跟随系统时，会随操作系统浅色 / 深色外观自动切换；选择结果保存在工作台偏好中。</p>
    <div className={css.group}>
      <h3 className={css.groupTitle}>界面</h3>
      <div className={`${css.settingRow} ${css.stack}`}>
        <div className={css.settingText}><div className={css.settingTitle}>主题</div><div className={css.settingDesc}>当前生效：{resolved}{following ? '（跟随系统）' : ''}</div></div>
        <div className={css.themeGrid}>
          <label className={css.themeCard}><input type="radio" name="studio-theme" value="system" checked={snapshot.preference === 'system'} onChange={() => props.theme.setPreference('system')} /><div className={`${css.themePreview} ${css.system}`}><div className={css.tpLight}><div className={css.tpBar} /><div className={css.tpLine} /><div className={`${css.tpLine} ${css.short}`} /></div><div className={css.tpDark}><div className={css.tpBar} /><div className={css.tpLine} /><div className={`${css.tpLine} ${css.short}`} /></div></div><span className={css.themeCardLabel}><Icon name="monitor" />跟随系统</span></label>
          <label className={css.themeCard}><input type="radio" name="studio-theme" value="light" checked={snapshot.preference === 'light'} onChange={() => props.theme.setPreference('light')} /><div className={css.themePreview}><div className={css.tpSide} /><div className={css.tpMain}><div className={css.tpBar} /><div className={css.tpLine} /><div className={`${css.tpLine} ${css.short}`} /></div></div><span className={css.themeCardLabel}><Icon name="sun" />浅色</span></label>
          <label className={css.themeCard}><input type="radio" name="studio-theme" value="dark" checked={snapshot.preference === 'dark'} onChange={() => props.theme.setPreference('dark')} /><div className={`${css.themePreview} ${css.dark}`}><div className={css.tpSide} /><div className={css.tpMain}><div className={css.tpBar} /><div className={css.tpLine} /><div className={`${css.tpLine} ${css.short}`} /></div></div><span className={css.themeCardLabel}><Icon name="moon" />深色</span></label>
        </div>
      </div>
    </div>
    <div className={css.note}><Icon name="info" /><span>界面的颜色、字体与间距跟随桌面宿主主题；深色模式由宿主自动切换，工作台不另设配色。</span></div>
  </Section>
}

function ConnectionSection(props: SectionProps) {
  const { state, loadError, refresh } = useStudioState(props.call)
  const connected = state.connected
  return <Section>
    <p className={css.sectionIntro}>协同后端由企业集中部署，客户端固定连接；项目、占用与登录状态以服务端为准。</p>
    <div className={css.kvBlock}>
      <div className={css.kv}><span className={css.kvK}>连接状态</span><span className={css.kvV}>{connected ? <><span className={`${css.dot} ${css.ok}`} />已连接</> : loadError ? '状态获取失败' : '未登录协同工作台'}</span></div>
      <div className={css.kv}><span className={css.kvK}>当前项目</span><span className={`${css.kvV} ${css.mono}`}>{state.project?.name ?? '未选择'}</span></div>
    </div>
    {loadError && <p className={css.inlineError} role="alert">{loadError}</p>}
    <div className={css.group}>
      <h3 className={css.groupTitle}>诊断</h3>
      <div className={css.settingRow}><div className={css.settingText}><div className={css.settingTitle}>重新同步状态</div><div className={css.settingDesc}>从协同后端重新拉取项目、占用与基线状态。</div></div><button className={css.ghostBtn} onClick={refresh}>重新同步</button></div>
    </div>
    <div className={css.note}><Icon name="info" /><span>本地原型服务仅监听 loopback；Git 推送使用本机凭据，不经过协同后端。</span></div>
  </Section>
}

function AboutSection(props: SectionProps) {
  const { state } = useStudioState(props.call)
  const snapshot = useSyncExternalStore(props.theme.subscribe, props.theme.getSnapshot)
  const preference = snapshot.preference === 'system' ? snapshot.active.colorScheme : snapshot.preference
  return <Section>
    <div className={css.aboutMark}><span className={css.logo} aria-hidden="true">e</span><div><div className={css.aboutName}>EADP Studio</div><div className={css.aboutSub}>内测通道</div></div></div>
    <div className={css.kvBlock}>
      <div className={css.kv}><span className={css.kvK}>当前项目</span><span className={`${css.kvV} ${css.mono}`}>{state.project?.name ?? '未选择'}</span></div>
      <div className={css.kv}><span className={css.kvK}>主题</span><span className={css.kvV}>{preference === 'dark' ? '深色' : '浅色'}</span></div>
    </div>
    <div className={css.note}><Icon name="info" /><span>业务资产保存在项目 Git 仓库；协同后端只持久保存身份、会话与控制元数据，不托管正文。</span></div>
  </Section>
}

function ScenarioTemplateSection(props: SectionProps) {
  const { state, setState, loadError, refresh } = useStudioState(props.call)
  return <Section>{loadError && <p role="alert" className={css.inlineError}>{loadError}<button onClick={refresh}>重试</button></p>}<ScenarioTemplateSettings state={state} call={props.call} onState={setState} /></Section>
}
