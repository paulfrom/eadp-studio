import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { StudioState } from '../../shared/studio.ts'
import type { ThemeFace } from '../theme.ts'
import css from './StudioSettings.module.css'

export type SettingsSection = 'account' | 'appearance' | 'connection' | 'models' | 'about'

const sections: Array<{ id: SettingsSection; name: string; icon: IconName }> = [
  { id: 'account', name: '账号与登录', icon: 'user' },
  { id: 'appearance', name: '外观', icon: 'sun' },
  { id: 'connection', name: '协同连接', icon: 'server' },
  { id: 'models', name: '模型与 Agent', icon: 'sparkle' },
  { id: 'about', name: '关于', icon: 'info' },
]

type IconName = 'user' | 'sun' | 'server' | 'sparkle' | 'info' | 'monitor' | 'moon' | 'lock' | 'logout' | 'close' | 'check'
const paths: Record<IconName, string> = {
  user: 'M12 8a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.6-6 8-6s8 2 8 6',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  server: 'M3 4h18v6H3zM3 14h18v6H3zM6 7h.01M6 17h.01',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 8v5M12 16.5h.01',
  monitor: 'M3 3h18v12H3zM8 21h8M12 17v4',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  lock: 'M6 11h12v9H6zM9 11V7a3 3 0 016 0v4',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M4 12l5 5L20 6',
}
function Icon({ name, className }: { name: IconName; className?: string }) {
  return <svg className={className ?? css.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

export function StudioSettings(props: {
  section: SettingsSection
  onSectionChange(section: SettingsSection): void
  onClose(): void
  state: StudioState
  busy: boolean
  error: string
  theme: ThemeFace
  onLogin(username: string, password: string): Promise<void>
  onLogout(): Promise<void>
  onRefresh(): void
  onOpenHostSettings(section?: string): void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const snapshot = useSyncExternalStore(props.theme.subscribe, props.theme.getSnapshot)
  const account = props.state.account
  useEffect(() => { const element = ref.current!; element.showModal(); return () => element.close() }, [])
  useEffect(() => { if (props.error) setPassword('') }, [props.error])
  const submitLogin = (event: FormEvent) => {
    event.preventDefault()
    const submitted = password
    setPassword('')
    void props.onLogin(username, submitted)
  }
  const preference = snapshot.preference === 'system' ? 'system' : snapshot.active.colorScheme
  const section = props.section
  return <dialog ref={ref} className={css.dialog} onCancel={props.onClose} aria-labelledby="studio-settings-title" tabIndex={-1}>
    <div className={css.shell}>
      <nav className={css.nav} aria-label="设置分类">
        <div className={css.navTitle}><h2 id="studio-settings-title">设置</h2><p>EADP Studio</p></div>
        {sections.map(item => <button key={item.id} className={`${css.navRow} ${section === item.id ? css.active : ''}`} aria-current={section === item.id ? 'page' : undefined} onClick={() => props.onSectionChange(item.id)}><Icon name={item.icon} /><span>{item.name}</span></button>)}
        <div className={css.navFoot}>内测通道</div>
      </nav>
      <div className={css.body}>
        <div className={css.head}><h2>{sections.find(item => item.id === section)!.name}</h2><button className={css.closeBtn} onClick={props.onClose} aria-label="关闭设置 (Esc)" title="关闭设置 (Esc)"><Icon name="close" /></button></div>
        <div className={css.content}>
          {section === 'account' && <AccountSection {...props} username={username} password={password} setUsername={setUsername} setPassword={setPassword} submitLogin={submitLogin} account={account} />}
          {section === 'appearance' && <AppearanceSection preference={preference} snapshotPreference={snapshot.preference} setPreference={props.theme.setPreference} />}
          {section === 'connection' && <ConnectionSection state={props.state} onRefresh={props.onRefresh} />}
          {section === 'models' && <ModelsSection onOpenHost={() => { props.onClose(); props.onOpenHostSettings('models') }} />}
          {section === 'about' && <AboutSection state={props.state} preference={preference} />}
        </div>
      </div>
    </div>
  </dialog>
}

function AccountSection(props: {
  state: StudioState; busy: boolean; error: string
  username: string; password: string; setUsername(value: string): void; setPassword(value: string): void
  submitLogin(event: FormEvent): void; onLogin(username: string, password: string): Promise<void>; onLogout(): Promise<void>
  account?: StudioState['account']
}) {
  const { account } = props
  if (account) return <>
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
        <button className={css.dangerBtn} disabled={props.busy} onClick={() => void props.onLogout()}><Icon name="logout" />退出登录</button>
      </div>
    </div>
    <div className={css.note}><Icon name="info" /><span>更换工作站后使用同一账号重新登录，项目与占用状态会从协同后端恢复；本机不保存密码，也不缓存项目正文。</span></div>
  </>
  return <>
    <p className={css.sectionIntro}>使用协同账号登录工作台，项目访问权限由后台管理；登录状态在本机系统安全存储中缓存，最长 90 天。</p>
    <div className={`${css.identityCard} ${css.signedOut}`}>
      <span className={css.identityAvatar}>?</span>
      <div><div className={css.identityName}>未登录协同工作台</div><div className={css.identityMeta}>登录后查看可用项目与当前占用。</div></div>
      <span className={css.chip}>未登录</span>
    </div>
    <form className={css.loginForm} onSubmit={props.submitLogin} noValidate>
      <div className={css.field}><label htmlFor="studio-login-username">用户名</label><input id="studio-login-username" required autoFocus autoComplete="username" value={props.username} onChange={event => props.setUsername(event.target.value)} placeholder="studioAdmin" maxLength={100} /></div>
      <div className={css.field}><label htmlFor="studio-login-password">密码</label><input id="studio-login-password" required type="password" autoComplete="current-password" value={props.password} onChange={event => props.setPassword(event.target.value)} placeholder="••••••••" maxLength={200} /></div>
      {props.error && <p className={css.inlineError} role="alert">{props.error}</p>}
      <button className={css.primaryBtn} type="submit" disabled={props.busy}>{props.busy ? '正在登录…' : '登录协同工作台'}</button>
      <p className={css.formNote}>账号与密码仅发送到固定协同后端；登录状态在本机系统安全存储中缓存，本机不写入密码。</p>
    </form>
    <div className={css.loginSep}>登录状态保存策略</div>
    <div className={css.note}><Icon name="lock" /><span>会话令牌在本机系统安全存储中缓存，默认最长 90 天；后端会话同步持久保存，退出登录会同时撤销远端会话。</span></div>
  </>
}

function AppearanceSection(props: { preference: string; snapshotPreference: string; setPreference(id: 'system' | 'light' | 'dark'): void }) {
  const resolved = props.preference === 'dark' ? '深色' : '浅色'
  const following = props.snapshotPreference === 'system'
  return <>
    <p className={css.sectionIntro}>主题跟随系统时，会随操作系统浅色 / 深色外观自动切换；选择结果保存在工作台偏好中。</p>
    <div className={css.group}>
      <h3 className={css.groupTitle}>界面</h3>
      <div className={`${css.settingRow} ${css.stack}`}>
        <div className={css.settingText}><div className={css.settingTitle}>主题</div><div className={css.settingDesc}>当前生效：{resolved}{following ? '（跟随系统）' : ''}</div></div>
        <div className={css.themeGrid}>
          <label className={css.themeCard}><input type="radio" name="theme" value="system" checked={props.snapshotPreference === 'system'} onChange={() => props.setPreference('system')} /><div className={`${css.themePreview} ${css.system}`}><div className={css.tpLight}><div className={css.tpBar} /><div className={css.tpLine} /><div className={`${css.tpLine} ${css.short}`} /></div><div className={css.tpDark}><div className={css.tpBar} /><div className={css.tpLine} /><div className={`${css.tpLine} ${css.short}`} /></div></div><span className={css.themeCardLabel}><Icon name="monitor" />跟随系统</span></label>
          <label className={css.themeCard}><input type="radio" name="theme" value="light" checked={props.snapshotPreference === 'light'} onChange={() => props.setPreference('light')} /><div className={css.themePreview}><div className={css.tpSide} /><div className={css.tpMain}><div className={css.tpBar} /><div className={css.tpLine} /><div className={`${css.tpLine} ${css.short}`} /></div></div><span className={css.themeCardLabel}><Icon name="sun" />浅色</span></label>
          <label className={css.themeCard}><input type="radio" name="theme" value="dark" checked={props.snapshotPreference === 'dark'} onChange={() => props.setPreference('dark')} /><div className={`${css.themePreview} ${css.dark}`}><div className={css.tpSide} /><div className={css.tpMain}><div className={css.tpBar} /><div className={css.tpLine} /><div className={`${css.tpLine} ${css.short}`} /></div></div><span className={css.themeCardLabel}><Icon name="moon" />深色</span></label>
        </div>
      </div>
    </div>
    <div className={css.note}><Icon name="info" /><span>界面只使用一套暖中性色与品牌蓝；深色模式沿用相同的层级关系与语义色，不另设配色。</span></div>
  </>
}

function ConnectionSection(props: { state: StudioState; onRefresh(): void }) {
  const connected = props.state.connected
  return <>
    <p className={css.sectionIntro}>协同后端由企业集中部署，客户端固定连接；项目、占用与登录状态以服务端为准。</p>
    <div className={css.kvBlock}>
      <div className={css.kv}><span className={css.kvK}>连接状态</span><span className={css.kvV}>{connected ? <><span className={`${css.dot} ${css.ok}`} />已连接</> : '未登录协同工作台'}</span></div>
      <div className={css.kv}><span className={css.kvK}>当前项目</span><span className={`${css.kvV} ${css.mono}`}>{props.state.project?.name ?? '未选择'}</span></div>
    </div>
    <div className={css.group}>
      <h3 className={css.groupTitle}>诊断</h3>
      <div className={css.settingRow}><div className={css.settingText}><div className={css.settingTitle}>重新同步状态</div><div className={css.settingDesc}>从协同后端重新拉取项目、占用与基线状态。</div></div><button className={css.ghostBtn} onClick={props.onRefresh}>重新同步</button></div>
    </div>
    <div className={css.note}><Icon name="info" /><span>本地原型服务仅监听 loopback；Git 推送使用本机凭据，不经过协同后端。</span></div>
  </>
}

function ModelsSection(props: { onOpenHost(): void }) {
  return <>
    <p className={css.sectionIntro}>模型与密钥由桌面宿主统一配置，工作台不另建模型接入层，也不保存密钥。</p>
    <div className={css.settingRow}>
      <div className={css.settingText}><div className={css.settingTitle}>宿主模型设置</div><div className={css.settingDesc}>在桌面宿主设置中配置模型接入、密钥与可用模型清单；变更对工作台会话立即生效。</div></div>
      <button className={css.ghostBtn} onClick={props.onOpenHost}>打开宿主模型设置</button>
    </div>
    <div className={css.note}><Icon name="info" /><span>模型调用沿用宿主既有审批与取消管线；工作台只绑定当前任务、材料与输入版本，不复制 Agent loop。</span></div>
  </>
}

function AboutSection(props: { state: StudioState; preference: string }) {
  return <>
    <div className={css.aboutMark}><span className={css.logo} aria-hidden="true">e</span><div><div className={css.aboutName}>EADP Studio</div><div className={css.aboutSub}>内测通道</div></div></div>
    <div className={css.kvBlock}>
      <div className={css.kv}><span className={css.kvK}>当前项目</span><span className={`${css.kvV} ${css.mono}`}>{props.state.project?.name ?? '未选择'}</span></div>
      <div className={css.kv}><span className={css.kvK}>主题</span><span className={css.kvV}>{props.preference === 'dark' ? '深色' : '浅色'}</span></div>
    </div>
    <div className={css.note}><Icon name="info" /><span>业务资产保存在项目 Git 仓库；协同后端只持久保存身份、会话与控制元数据，不托管正文。</span></div>
  </>
}
