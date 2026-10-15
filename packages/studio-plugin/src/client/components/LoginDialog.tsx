import { useEffect, useRef, useState } from 'react'
import css from '../studio.module.css'

export function LoginDialog({ busy, error, onClose, onSubmit }: { busy: boolean; error: string; onClose(): void; onSubmit(username: string, password: string): Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [username, setUsername] = useState(''), [password, setPassword] = useState('')
  useEffect(() => { const element = ref.current!; element.showModal(); return () => element.close() }, [])
  return <dialog ref={ref} className={css.dialog} onCancel={onClose} aria-labelledby="studio-login-title"><form onSubmit={event => {
    event.preventDefault(); const submitted = password; setPassword(''); void onSubmit(username, submitted)
  }}><header><div><p className={css.eyebrow}>STUDIO ACCOUNT</p><h2 id="studio-login-title">登录协同工作台</h2></div><button type="button" onClick={onClose} aria-label="关闭">×</button></header>
    <p>使用协同账号登录，项目访问权限由后台管理。</p>
    <label>用户名<input required autoFocus autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} maxLength={100} /></label>
    <label>密码<input required type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} maxLength={200} /></label>
    {error && <p className={css.error} role="alert">{error}</p>}
    <footer><button type="button" onClick={onClose}>取消</button><button className={css.primary} disabled={busy}>{busy ? '正在登录…' : '登录'}</button></footer>
  </form></dialog>
}
