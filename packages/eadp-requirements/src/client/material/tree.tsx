import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { RequirementEntry } from '@eadp/contracts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconButton,
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconMore,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
  Menu,
  Spinner,
} from '@eadp/shell/client/ui'
import { NS } from '../locales.ts'
import css from '../material-editor.module.css'

/** Requirement files live only under this Host-owned folder. */
const REQUIREMENTS_ROOT = '需求'

interface FileNode { kind: 'file'; path: string; name: string }
interface DirectoryNode { kind: 'directory'; path: string; name: string; children: TreeNode[] }
type TreeNode = FileNode | DirectoryNode

interface DirectoryBucket { directories: Map<string, DirectoryBucket>; files: Map<string, FileNode> }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Turns the flat Host listing into a stable directory tree. */
export function buildTree(entries: RequirementEntry[]): TreeNode[] {
  const root: DirectoryBucket = { directories: new Map(), files: new Map() }
  for (const entry of entries) {
    if (!entry.relativePath.startsWith(`${REQUIREMENTS_ROOT}/`)) continue
    const names = entry.relativePath.slice(REQUIREMENTS_ROOT.length + 1).split('/')
    let bucket = root
    for (const name of names.slice(0, -1)) {
      let next = bucket.directories.get(name)
      if (!next) {
        next = { directories: new Map(), files: new Map() }
        bucket.directories.set(name, next)
      }
      bucket = next
    }
    const name = names[names.length - 1] ?? ''
    if (entry.type === 'directory') {
      if (!bucket.directories.has(name)) bucket.directories.set(name, { directories: new Map(), files: new Map() })
    } else bucket.files.set(name, { kind: 'file', path: entry.relativePath, name })
  }
  const collect = (bucket: DirectoryBucket, prefix: string): TreeNode[] => [
    ...[...bucket.directories.entries()]
      .sort(([left], [right]) => collator.compare(left, right))
      .map(([name, child]): DirectoryNode => ({ kind: 'directory', path: `${prefix}/${name}`, name, children: collect(child, `${prefix}/${name}`) })),
    ...[...bucket.files.values()].sort((left, right) => collator.compare(left.name, right.name)),
  ]
  return collect(root, REQUIREMENTS_ROOT)
}

interface VisibleNode { node: TreeNode; depth: number; parent?: string | undefined }

function flatten(nodes: TreeNode[], collapsed: ReadonlySet<string>, depth = 0, parent?: string): VisibleNode[] {
  const rows: VisibleNode[] = []
  for (const node of nodes) {
    rows.push({ node, depth, parent })
    if (node.kind === 'directory' && !collapsed.has(node.path)) rows.push(...flatten(node.children, collapsed, depth + 1, node.path))
  }
  return rows
}

export interface MaterialTreeProps extends PropsLocale<typeof NS> {
  entries: RequirementEntry[]
  selectedPath?: string | undefined
  contextPresent: boolean
  loading: boolean
  disabled: boolean
  onOpen(path: string): void
  onCreate(): void
  onCreateFolder(): void
  onRefresh(): void
  onRename(path: string): void
  onRemove(path: string): void
}

/** 248px material tree: project context row, requirement groups and row actions. */
export function MaterialTree(props: MaterialTreeProps) {
  const { entries, selectedPath, contextPresent, loading, disabled, t } = props
  const nodes = useMemo(() => buildTree(entries), [entries])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [activeIndex, setActiveIndex] = useState(0)
  const rows = useMemo(() => flatten(nodes, collapsed), [nodes, collapsed])
  const active = rows.length === 0 ? -1 : Math.min(activeIndex, rows.length - 1)
  const elements = useRef<(HTMLLIElement | null)[]>([])

  const focusRow = (index: number): void => {
    const next = Math.max(0, Math.min(index, rows.length - 1))
    setActiveIndex(next)
    elements.current[next]?.focus()
  }
  const toggle = (path: string): void => {
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const activate = (node: TreeNode): void => {
    if (node.kind === 'directory') toggle(node.path)
    else props.onOpen(node.path)
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>, index: number): void => {
    /* Row navigation owns only the row itself; the row action menu keeps its own keys. */
    if (event.target !== event.currentTarget) return
    const row = rows[index]
    if (!row) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusRow(index + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusRow(index - 1)
        break
      case 'Home':
        event.preventDefault()
        focusRow(0)
        break
      case 'End':
        event.preventDefault()
        focusRow(rows.length - 1)
        break
      case 'ArrowRight':
        event.preventDefault()
        if (row.node.kind !== 'directory') break
        if (collapsed.has(row.node.path)) toggle(row.node.path)
        else if (rows[index + 1]?.parent === row.node.path) focusRow(index + 1)
        break
      case 'ArrowLeft': {
        event.preventDefault()
        if (row.node.kind === 'directory' && !collapsed.has(row.node.path)) {
          toggle(row.node.path)
          break
        }
        if (row.parent) {
          const parent = rows.findIndex(candidate => candidate.node.path === row.parent)
          if (parent >= 0) focusRow(parent)
        }
        break
      }
      case 'Enter':
      case ' ':
        event.preventDefault()
        activate(row.node)
        break
      case 'F2':
        if (row.node.kind === 'file') {
          event.preventDefault()
          props.onRename(row.node.path)
        }
        break
      case 'Delete':
        if (row.node.kind === 'file') {
          event.preventDefault()
          props.onRemove(row.node.path)
        }
        break
      default:
        break
    }
  }

  return <aside className={css.materialTree} aria-label={t('title')}>
    <header className={css.treeHeader}>
      <strong className={css.treeTitle}>{t('title')}</strong>
      <IconButton label={t('create')} size="sm" disabled={disabled} onClick={props.onCreate}><IconPlus /></IconButton>
      <IconButton label={t('folder')} size="sm" disabled={disabled} onClick={props.onCreateFolder}><IconFolder /></IconButton>
      <IconButton label={t('refresh')} size="sm" disabled={disabled || loading} onClick={props.onRefresh}><IconRefresh /></IconButton>
    </header>
    <div className={css.treeBody}>
      <button
        type="button"
        className={css.contextRow}
        data-selected={selectedPath === 'CONTEXT.md' || undefined}
        data-absent={contextPresent ? undefined : 'true'}
        onClick={() => props.onOpen('CONTEXT.md')}>
        <span className={css.treeIcon}><IconFile /></span>
        <span className={css.treeLabel}>{t('context')}</span>
      </button>
      {rows.length > 0 ? <ul className={css.treeList} role="tree" aria-label={t('title')} aria-busy={loading || undefined}>
        {rows.map((row, index) => row.node.kind === 'directory'
          ? <li
            key={row.node.path}
            ref={element => { elements.current[index] = element }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={!collapsed.has(row.node.path)}
            tabIndex={index === active ? 0 : -1}
            className={css.treeRow}
            data-depth={row.depth}
            style={{ paddingLeft: 8 + row.depth * 12 }}
            onClick={() => { setActiveIndex(index); toggle(row.node.path) }}
            onKeyDown={event => onKeyDown(event, index)}>
            <span className={css.treeChevron}>{collapsed.has(row.node.path) ? <IconChevronRight /> : <IconChevronDown />}</span>
            <span className={css.treeIcon}>{collapsed.has(row.node.path) ? <IconFolder /> : <IconFolderOpen />}</span>
            <span className={css.treeLabel} title={row.node.path}>{row.node.name}</span>
          </li>
          : <li
            key={row.node.path}
            ref={element => { elements.current[index] = element }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={selectedPath === row.node.path}
            tabIndex={index === active ? 0 : -1}
            className={css.treeRow}
            data-depth={row.depth}
            data-selected={selectedPath === row.node.path || undefined}
            style={{ paddingLeft: 8 + row.depth * 12 }}
            onClick={() => { setActiveIndex(index); props.onOpen(row.node.path) }}
            onKeyDown={event => onKeyDown(event, index)}>
            <span className={css.treeChevronSpacer} />
            <span className={css.treeIcon}><IconFile /></span>
            <span className={css.treeLabel} title={row.node.path}>{row.node.name}</span>
            <span className={css.treeMore} onClick={event => event.stopPropagation()}>
              <Menu
                label={t('fileActions')}
                align="end"
                trigger={<IconButton label={t('moreActions')} size="sm" disabled={disabled}><IconMore /></IconButton>}
                items={[
                  { id: 'rename', label: t('rename'), icon: <IconPencil />, onSelect: () => props.onRename(row.node.path) },
                  { id: 'remove', label: t('remove'), icon: <IconTrash />, danger: true, onSelect: () => props.onRemove(row.node.path) },
                ]} />
            </span>
          </li>)}
      </ul> : null}
      {loading ? <p className={css.treeNote}><Spinner size="sm" />{t('loading')}</p> : rows.length === 0 ? <p className={css.treeNote}>{t('empty')}</p> : null}
    </div>
  </aside>
}
