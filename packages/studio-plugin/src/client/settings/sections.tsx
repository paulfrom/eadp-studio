/** Studio sections inside the host settings dialog: registered on `settings.section`, one entry per concern. */

import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import type { StudioState } from '../../shared/studio.ts'
import type { StudioSessionActions } from '../session.ts'
import type { StudioProjectionStore } from '../store.ts'
import type { ThemeFace } from '../theme.ts'
import studioCss from '../studio.module.css'
import css from './sections.module.css'
import { ScenarioTemplateSettings } from './ScenarioTemplateSettings.tsx'

/** Faces the Studio settings sections act through (wired from the client context). */
export interface StudioSettingsFaces extends StudioSessionActions {
  theme: ThemeFace
}

/** Props every Studio settings section receives: runtime seats, the session faces, and the shared projection store. */
export type StudioSectionProps = PropsRuntime<'settings.section'> & StudioSettingsFaces & PropsStore<StudioProjectionStore>

type SectionProps = StudioSectionProps

/** The shared projection a section renders: one read for the whole settings surface. */
interface StudioSettingsView {
  /** Undefined until the first answer arrives; never assume it means signed out. */
  projection: StudioState | undefined
  loading: boolean
  error: string
}

/**
 * Read the shared projection and keep it fresh while a section is mounted.
 * Mounting is the only trigger a closed dialog does not pay for; the session
 * joins those concurrent requests into one Host round trip, and the workbench
 * panel reads the same store, so no cross-surface announcement is needed.
 */
function useStudioSettings(props: StudioSectionProps): StudioSettingsView {
  const projection = props.useStore(snapshot => snapshot.projection)
  const loading = props.useStore(snapshot => snapshot.loading)
  const error = props.useStore(snapshot => snapshot.error)
  const sync = props.sync
  useEffect(() => { sync() }, [sync])
  return { projection, loading, error }
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

/** Placeholder for a section whose first projection has not arrived: the Host has not answered yet. */
function Loading({ label }: { label: string }) {
  return <div className={css.loadingCard} role="status" aria-busy="true">
    <span className={css.spinner} aria-hidden="true" />
    <div><div className={css.identityName}>{label}</div><div className={css.identityMeta}>正在从本机工作台服务读取状态…</div></div>
  </div>
}

/** Failure text for a projection the Host did not deliver; a retry re-reads it. */
function Unavailable({ detail, onRetry }: { detail: string; onRetry: () => void }) {
  return <>
    <p className={css.sectionIntro}>协同工作台状态暂时无法确认；请重试，或检查本机工作台服务是否正常。</p>
    <div className={css.identityCard}>
      <span className={css.identityAvatar}>!</span>
      <div><div className={css.identityName}>无法获取登录状态</div><div className={css.identityMeta}>{detail || '工作台状态暂未确认，请重试。'}</div></div>
      <button className={css.ghostBtn} onClick={onRetry}>重试</button>
    </div>
  </>
}

/** Inline notice that a refresh is under way; the visible projection stays in place. */
function Syncing() {
  return <span className={css.syncNote} role="status"><span className={css.spinner} aria-hidden="true" />正在同步…</span>
}

function CollabAccountSection(props: SectionProps) {
  const { projection, loading, error } = useStudioSettings(props)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const account = projection?.account
  useEffect(() => { if (failure) setPassword('') }, [failure])
  const submitLogin = (event: FormEvent) => {
    event.preventDefault()
    const submitted = password
    setPassword('')
    setBusy(true)
    void props.login(username, submitted).then(text => {
      if (text) { setFailure(text); return }
      setUsername(''); setFailure('')
    }).finally(() => setBusy(false))
  }
  const logout = () => {
    setBusy(true)
    void props.logout().then(text => {
      if (text) { setFailure(text); return }
      setFailure('')
    }).finally(() => setBusy(false))
  }
  return <Section>
    {projection === undefined
      // The first answer has not arrived: "signed out" is not yet a fact.
      ? loading ? <Loading label="正在读取登录状态" /> : <Unavailable detail={error} onRetry={props.sync} />
      : !account ? <>
        <p className={css.sectionIntro}>使用协同账号登录工作台，项目访问权限由后台管理；登录状态在本机系统安全存储中缓存，最长 90 天。</p>
        <div className={`${css.identityCard} ${css.signedOut}`}>
          <span className={css.identityAvatar}>?</span>
          <div><div className={css.identityName}>未登录协同工作台</div><div className={css.identityMeta}>登录后查看可用项目与当前占用。</div></div>
          <span className={css.chip}>{loading ? '正在同步' : '未登录'}</span>
        </div>
        <form className={css.loginForm} onSubmit={submitLogin} noValidate>
          <div className={css.field}><label htmlFor="studio-login-username">用户名</label><input id="studio-login-username" required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="studioAdmin" maxLength={100} /></div>
          <div className={css.field}><label htmlFor="studio-login-password">密码</label><input id="studio-login-password" required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="••••••••" maxLength={200} /></div>
          {(failure || error) && <p className={css.inlineError} role="alert">{failure || error}</p>}
          <button className={css.primaryBtn} type="submit" disabled={busy}>{busy ? '正在登录…' : '登录协同工作台'}</button>
          <p className={css.formNote}>账号与密码仅发送到固定协同后端；登录状态在本机系统安全存储中缓存，本机不写入密码。</p>
        </form>
        <div className={css.loginSep}>登录状态保存策略</div>
        <div className={css.note}><Icon name="lock" /><span>会话令牌在本机系统安全存储中缓存，默认最长 90 天；后端会话同步持久保存，退出登录会同时撤销远端会话。</span></div>
      </> : <>
        <p className={css.sectionIntro}>协同身份用于登录工作台、校验项目访问权限；Git 推送仍使用本机 Git 凭据。</p>
        <div className={css.identityCard}>
          <span className={css.identityAvatar}>{account.name.slice(0, 1) || '@'}</span>
          <div><div className={css.identityName}>{account.name}</div><div className={css.identityMeta}>@{account.username} · 协同用户 {account.id}<br />绑定 GitLab @{account.gitlabUsername}</div></div>
          <span className={`${css.chip} ${css.ok}`}>已登录</span>
        </div>
        <div className={css.group}>
          <h3 className={css.groupTitle}>登录状态 {loading && <Syncing />}</h3>
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
        {error && <p className={css.inlineError} role="alert">{error}</p>}
        {failure && <p className={css.inlineError} role="alert">{failure}</p>}
        <div className={css.note}><Icon name="info" /><span>更换工作站后使用同一账号重新登录，项目与占用状态会从协同后端恢复；本机不保存密码，也不缓存项目正文。</span></div>
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
  const { projection, loading, error } = useStudioSettings(props)
  const connected = projection?.connected ?? false
  return <Section>
    <p className={css.sectionIntro}>协同后端由企业集中部署，客户端固定连接；项目、占用与登录状态以服务端为准。</p>
    {projection === undefined && !loading
      ? <Unavailable detail={error} onRetry={props.sync} />
      : <>
        <div className={css.kvBlock}>
          <div className={css.kv}><span className={css.kvK}>连接状态</span><span className={css.kvV}>{projection === undefined ? '正在读取状态' : connected ? <><span className={`${css.dot} ${css.ok}`} />已连接</> : '未登录协同工作台'}</span></div>
          <div className={css.kv}><span className={css.kvK}>当前项目</span><span className={`${css.kvV} ${css.mono}`}>{projection === undefined ? '正在读取…' : projection.project?.name ?? '未选择'}</span></div>
        </div>
        {error && <p className={css.inlineError} role="alert">{error}</p>}
        <div className={css.group}>
          <h3 className={css.groupTitle}>诊断 {loading && <Syncing />}</h3>
          <div className={css.settingRow}><div className={css.settingText}><div className={css.settingTitle}>重新同步状态</div><div className={css.settingDesc}>从协同后端重新拉取项目、占用与基线状态。</div></div><button className={css.ghostBtn} disabled={loading} onClick={props.sync}>{loading ? '正在同步…' : '重新同步'}</button></div>
        </div>
      </>}
    <div className={css.note}><Icon name="info" /><span>本地原型服务仅监听 loopback；Git 推送使用本机凭据，不经过协同后端。</span></div>
  </Section>
}

function AboutSection(props: SectionProps) {
  const { projection, loading, error } = useStudioSettings(props)
  const snapshot = useSyncExternalStore(props.theme.subscribe, props.theme.getSnapshot)
  const preference = snapshot.preference === 'system' ? snapshot.active.colorScheme : snapshot.preference
  const project = projection === undefined ? (loading ? '正在读取…' : '无法确认') : projection.project?.name ?? '未选择'
  return <Section>
    <div className={css.aboutMark}><span className={css.logo} aria-hidden="true">e</span><div><div className={css.aboutName}>EADP Studio</div><div className={css.aboutSub}>内测通道</div></div></div>
    <div className={css.kvBlock}>
      <div className={css.kv}><span className={css.kvK}>当前项目</span><span className={`${css.kvV} ${css.mono}`}>{project}</span></div>
      <div className={css.kv}><span className={css.kvK}>主题</span><span className={css.kvV}>{preference === 'dark' ? '深色' : '浅色'}</span></div>
    </div>
    {error && <p className={css.inlineError} role="alert">{error}</p>}
    <div className={css.note}><Icon name="info" /><span>业务资产保存在项目 Git 仓库；协同后端只持久保存身份、会话与控制元数据，不托管正文。</span></div>
  </Section>
}

/**
 * Project template editing: the fifth section, reading the same shared projection
 * and writing through the same owner as the account sections. Without a project
 * there is nothing to manage, and without a first answer there is not yet a fact.
 */
function ScenarioTemplateSection(props: SectionProps) {
  const { projection, loading, error } = useStudioSettings(props)
  if (projection === undefined) {
    return <Section>{loading ? <Loading label="正在读取场景模板" /> : <Unavailable detail={error} onRetry={props.sync} />}</Section>
  }
  return <Section>
    <ScenarioTemplateSettings state={projection} run={props.run} />
    {error && <p role="alert" className={css.inlineError}>{error}<button onClick={props.sync}>重试</button></p>}
  </Section>
}
