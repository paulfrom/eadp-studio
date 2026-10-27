/**
 * Declarative topbar items: the toolbar/caption actions are data, not markup.
 * Features add entries here (or register more at runtime later) without touching
 * the renderer; the same list feeds the desktop caption band and the web toolbar.
 */

import type { Stage, StudioState } from '../../shared/studio.ts'
import type { ThemeFace } from '../theme.ts'

/** Everything an item's run() may act on, wired by StudioPanel from the panel faces. */
export interface TopbarFaces {
  state: StudioState
  busy: boolean
  theme: ThemeFace
  stage: Stage
  stages: ReadonlyArray<{ id: Stage; name: string }>
  refresh(): void
  selectStage(stage: Stage): void
  startSession(): void
  openSettings(section?: string): void
}

/** Presentation context only the renderer knows. */
export interface TopbarContext {
  /** Windows caption band active — the sidebar toggle lives in the caption, not the view menu. */
  captioned: boolean
  preference: string
  /** Toggle the Studio rail (only reachable from the view menu when not captioned). */
  toggleSidebar(): void
}

export type TopbarItem = {
  id: string
  label: string
  /** Accent-filled action (the primary command of the bar). */
  primary?: boolean
  href?: string
  title?: string
  checked?: boolean
  disabled?: boolean
  visible?: boolean
  run?(): void
  items?: ReadonlyArray<MenuEntry>
}

/** Non-interactive menu furniture; absence of `kind` on a MenuEntry means an action item. */
export type MenuEntry =
  | { kind: 'sep'; id: string }
  | { kind: 'label'; id: string; label: string }
  | TopbarItem

/** Build the current item list. Pure: re-runs every render, no hidden state. */
export function topbarItems(faces: TopbarFaces, context: TopbarContext): TopbarItem[] {
  const items: TopbarItem[] = [
    { id: 'new-session', label: '新建会话', primary: true, title: '回到宿主原生界面，开始一个新会话', run: () => faces.startSession() },
  ]
  const selectedTaskId = faces.state.prototypeQueue?.selectedTaskId
  const selectedTask = faces.state.prototypeQueue?.items.find(task => task.prototypeTaskId === selectedTaskId && task.projectId === faces.state.project?.id)
  const preview = faces.state.prototypePreviews?.find(item => item.prototypeTaskId === selectedTask?.prototypeTaskId)
  if (preview) items.push({ id: 'preview', label: '● 本地原型 ↗', href: preview.url, title: '在新窗口打开当前事项的原型预览' })
  items.push({
    id: 'view',
    label: '视图',
    items: [
      ...faces.stages.map((stage): MenuEntry => ({ id: `stage-${stage.id}`, label: stage.name, checked: faces.stage === stage.id, run: () => faces.selectStage(stage.id) })),
      { kind: 'sep', id: 'view-theme-sep' },
      { kind: 'label', id: 'view-theme-label', label: '主题' },
      { id: 'theme-system', label: '主题：跟随系统', checked: context.preference === 'system', run: () => faces.theme.setPreference('system') },
      { id: 'theme-light', label: '主题：浅色', checked: context.preference === 'light', run: () => faces.theme.setPreference('light') },
      { id: 'theme-dark', label: '主题：深色', checked: context.preference === 'dark', run: () => faces.theme.setPreference('dark') },
      ...(context.captioned ? [] : [
        { kind: 'sep', id: 'view-sidebar-sep' },
        { id: 'toggle-sidebar', label: '折叠侧栏', run: () => context.toggleSidebar() },
      ] satisfies MenuEntry[]),
    ],
  })
  items.push({ id: 'settings', label: '设置', title: '打开统一设置 (Ctrl+,)', run: () => faces.openSettings('studio-collab') })
  items.push({ id: 'refresh', label: '刷新', disabled: faces.busy, run: () => faces.refresh() })
  return items
}
