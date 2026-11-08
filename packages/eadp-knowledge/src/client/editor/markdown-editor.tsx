/**
 * 知识正文的所见即所得编辑器。
 *
 * 阅读态与编辑态共用同一棵节点树与同一套样式，只切换是否可编辑、是否显示工具栏。
 * 正文以资料保存形态（相对资源引用的 Markdown）进出：载入时换成可显示地址，
 * 取回时还原相对引用并把新插入的图片交给资料保存。
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
  type ForwardRefExoticComponent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type RefAttributes,
} from 'react'
import {
  $createParagraphNode,
  $getRoot,
  type LexicalEditor,
} from 'lexical'
import { $convertFromMarkdownString } from '@lexical/markdown'
import { LexicalComposer, type InitialConfigType } from '@lexical/react/LexicalComposer'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { TablePlugin } from '@lexical/react/LexicalTablePlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode'
import { CodeNode } from '@lexical/code'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import { ListItemNode, ListNode } from '@lexical/list'
import { LinkNode } from '@lexical/link'
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table'
import { EditorToolbar } from './toolbar.tsx'
import { ImageNode } from './nodes.tsx'
import {
  IMPORT_TRANSFORMERS,
  createAssetReverseMap,
  readDocumentPayload,
  readEditorStatePayload,
  resolveAssetUrls,
  type EditorSavePayload,
} from './markdown.ts'
import css from './editor.module.css'

export type { EditorSavePayload } from './markdown.ts'

/** 面板通过 ref 取回保存所需内容并聚焦正文。 */
export interface MarkdownEditorHandle {
  /** 导出当前正文与新插入的图片资源；编辑器未挂载时返回空内容。 */
  getPayload(): EditorSavePayload
  /** 把焦点移回正文。 */
  focus(): void
}

/** 编辑器入参：正文以保存形态传入，资源以相对路径到可显示地址的映射传入。 */
export interface MarkdownEditorProps {
  markdown: string
  /** 正文相对资源路径（如 `assets/<hash>.png`）到可直接显示地址的映射。 */
  assets: Record<string, string>
  readOnly?: boolean
  ariaLabel?: string
  /** 内容相对载入时是否发生变化；每次编辑后回调。 */
  onChange?: (changed: boolean) => void
}

/** 载入快照：只有正文变化时才重建编辑器，普通重渲染不打断输入。 */
interface LoadedDocument {
  markdown: string
  assets: Record<string, string>
  version: number
}

const EDITOR_NAMESPACE = 'eadp-knowledge-document'

/** 编辑器接受的节点类型；与载入、导出规则一一对应。 */
const EDITOR_NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  LinkNode,
  TableNode,
  TableRowNode,
  TableCellNode,
  HorizontalRuleNode,
  ImageNode,
]

/** 编辑器内部错误只写诊断日志，不打断面板其它操作。 */
function reportEditorError(error: Error): void {
  console.error('知识正文编辑失败', error)
}

/** 阅读态下链接只提示可识别，不跳转到外部地址。 */
function blockLinkNavigation(event: ReactMouseEvent<HTMLDivElement>): void {
  const target = event.target
  if (target instanceof Element && target.closest('a') !== null) event.preventDefault()
}

interface EditorBridgeProps {
  onEditor: (editor: LexicalEditor | null) => void
  readOnly: boolean
}

/** 把编辑器实例交给外层组件，并同步可编辑状态。 */
function EditorBridge({ onEditor, readOnly }: EditorBridgeProps): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    onEditor(editor)
    return () => onEditor(null)
  }, [editor, onEditor])
  useEffect(() => {
    editor.setEditable(!readOnly)
  }, [editor, readOnly])
  return null
}

interface ChangeReporterProps {
  reverse: ReadonlyMap<string, string>
  readOnly: boolean
  onChange: (changed: boolean) => void
}

/** 把内容变化换算成“相对载入时是否已修改”，撤销回载入内容时回到未修改。 */
function ChangeReporter({ reverse, readOnly, onChange }: ChangeReporterProps): null {
  const [editor] = useLexicalComposerContext()
  const baseline = useRef<string | null>(null)
  const notify = useRef(onChange)
  notify.current = onChange
  useEffect(() => {
    /*
     * 载入本身也是一次异步提交：第一次更新（此前状态还是空）作为基线，
     * 不报“已修改”，避免面板一打开就显示有未保存改动。
     */
    return editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves }) => {
      if (readOnly) return
      if (baseline.current === null || prevEditorState.isEmpty()) {
        const emptyBaseline = baseline.current === null
        baseline.current = readEditorStatePayload(editorState, reverse).text
        if (emptyBaseline) notify.current(false)
        return
      }
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return
      notify.current(readEditorStatePayload(editorState, reverse).text !== baseline.current)
    })
  }, [editor, readOnly, reverse])
  return null
}

interface EditorSurfaceProps {
  initialMarkdown: string
  reverse: ReadonlyMap<string, string>
  readOnly: boolean
  ariaLabel: string | undefined
  onChange: ((changed: boolean) => void) | undefined
  onEditor: (editor: LexicalEditor | null) => void
}

/**
 * 单个文档的编辑器实例；外层用 key 在正文变化时整体重建，因此这里只读首次入参。
 */
function EditorSurface(props: EditorSurfaceProps): ReactElement {
  const { initialMarkdown, reverse, readOnly, ariaLabel, onChange, onEditor } = props
  const [initialConfig] = useState<InitialConfigType>(() => ({
    namespace: EDITOR_NAMESPACE,
    nodes: EDITOR_NODES,
    onError: reportEditorError,
    editable: !readOnly,
    editorState: () => {
      $convertFromMarkdownString(initialMarkdown, IMPORT_TRANSFORMERS)
      const root = $getRoot()
      if (root.getChildrenSize() === 0) root.append($createParagraphNode())
      root.selectStart()
    },
  }))

  return (
    <div className={css.editor} onClickCapture={blockLinkNavigation}>
      <LexicalComposer initialConfig={initialConfig}>
        <EditorBridge onEditor={onEditor} readOnly={readOnly} />
        <HistoryPlugin />
        <ListPlugin />
        <TablePlugin hasCellMerge={false} hasCellBackgroundColor={false} hasHorizontalScroll={false} />
        {readOnly ? null : <EditorToolbar />}
        <div className={css.paper} data-read-only={readOnly ? 'true' : undefined}>
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                className={css.document}
                aria-label={ariaLabel}
                aria-multiline={true}
              />
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        {onChange === undefined ? null : (
          <ChangeReporter reverse={reverse} readOnly={readOnly} onChange={onChange} />
        )}
      </LexicalComposer>
    </div>
  )
}

/**
 * 正文编辑器；阅读态与编辑态是同一组件，仅切换可编辑状态与工具栏。
 * `markdown` 变化时重建编辑器（回到载入内容），同一正文的重渲染不会覆盖输入。
 */
export const MarkdownEditor: ForwardRefExoticComponent<
  MarkdownEditorProps & RefAttributes<MarkdownEditorHandle>
> = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(props, ref) {
  const { markdown, assets, readOnly = false, ariaLabel, onChange } = props
  const [loaded, setLoaded] = useState<LoadedDocument>(() => ({ markdown, assets, version: 0 }))
  if (loaded.markdown !== markdown) {
    setLoaded({ markdown, assets, version: loaded.version + 1 })
  }

  const reverse = useMemo(() => createAssetReverseMap(loaded.assets), [loaded.assets])
  const initialMarkdown = useMemo(
    () => resolveAssetUrls(loaded.markdown, loaded.assets),
    [loaded.markdown, loaded.assets],
  )
  const reverseRef = useRef(reverse)
  reverseRef.current = reverse
  const editorRef = useRef<LexicalEditor | null>(null)
  const handleEditor = useCallback((editor: LexicalEditor | null) => {
    editorRef.current = editor
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      getPayload: () => {
        const editor = editorRef.current
        return editor === null
          ? { text: '', resources: [] }
          : readDocumentPayload(editor, reverseRef.current)
      },
      focus: () => editorRef.current?.focus(),
    }),
    [],
  )

  return (
    <EditorSurface
      key={loaded.version}
      initialMarkdown={initialMarkdown}
      reverse={reverse}
      readOnly={readOnly}
      ariaLabel={ariaLabel}
      onChange={onChange}
      onEditor={handleEditor}
    />
  )
})
