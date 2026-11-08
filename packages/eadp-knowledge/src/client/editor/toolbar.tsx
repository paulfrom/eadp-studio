/**
 * 编辑态工具栏：正文样式、行内样式、列表与引用、插入表格/图片、撤销与重做。
 * 按钮只调用编辑器自带的命令或节点工具，不自己拦截输入与输入法事件。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  type RangeSelection,
} from 'lexical'
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode } from '@lexical/rich-text'
import { $insertList, $isListNode, $removeList, type ListType } from '@lexical/list'
import { $setBlocksType } from '@lexical/selection'
import { INSERT_TABLE_COMMAND } from '@lexical/table'
import { $findMatchingParent, $insertNodeToNearestRoot } from '@lexical/utils'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createImageNode } from './nodes.tsx'
import css from './editor.module.css'

/** 单张图片的上限；与资料保存的资源限制保持一致。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 资料保存接受的图片格式；提前拦住其它格式，避免存到最后才失败。 */
const SUPPORTED_IMAGE_TYPES = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/bmp', 'bmp'],
  ['image/svg+xml', 'svg'],
])

type BlockStyle = 'paragraph' | 'heading' | 'subheading' | 'quote' | 'bulleted' | 'numbered'

interface ToolbarState {
  block: BlockStyle
  bold: boolean
  italic: boolean
}

const INITIAL_STATE: ToolbarState = { block: 'paragraph', bold: false, italic: false }

/** 段落样式按钮；标题固定为二级标题，小标题固定为三级标题。 */
const STYLE_OPTIONS: Array<{ style: BlockStyle; label: string }> = [
  { style: 'paragraph', label: '正文' },
  { style: 'heading', label: '标题' },
  { style: 'subheading', label: '小标题' },
]

/** 读取当前选区对应的工具栏状态。 */
function $readToolbarState(): ToolbarState {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return INITIAL_STATE
  const highlight = {
    bold: selection.hasFormat('bold'),
    italic: selection.hasFormat('italic'),
  }
  const anchor = selection.anchor.getNode()
  const list = $findMatchingParent(anchor, $isListNode)
  if (list !== null) {
    return { block: list.getListType() === 'number' ? 'numbered' : 'bulleted', ...highlight }
  }
  const heading = $findMatchingParent(anchor, $isHeadingNode)
  if (heading !== null) {
    return { block: heading.getTag() === 'h3' ? 'subheading' : 'heading', ...highlight }
  }
  if ($findMatchingParent(anchor, $isQuoteNode) !== null) {
    return { block: 'quote', ...highlight }
  }
  return { block: 'paragraph', ...highlight }
}

/** 在当前选区切换列表类型；已经是同类型列表时移除列表。 */
function $toggleList(selection: RangeSelection, listType: ListType): void {
  const list = $findMatchingParent(selection.anchor.getNode(), $isListNode)
  if (list === null) {
    $insertList(listType)
    return
  }
  if (list.getListType() === listType) $removeList()
  else $insertList(listType)
}

/** 把选区内块级元素切换为指定样式。 */
function $applyBlockStyle(selection: RangeSelection, style: BlockStyle): void {
  switch (style) {
    case 'paragraph':
      $setBlocksType(selection, () => $createParagraphNode())
      return
    case 'heading':
      $setBlocksType(selection, () => $createHeadingNode('h2'))
      return
    case 'subheading':
      $setBlocksType(selection, () => $createHeadingNode('h3'))
      return
    case 'quote':
      $setBlocksType(selection, () => $createQuoteNode())
      return
    case 'bulleted':
      $toggleList(selection, 'bullet')
      return
    case 'numbered':
      $toggleList(selection, 'number')
  }
}

/** 读取图片文件为 data URL；失败时抛出可展示的说明。 */
function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('图片读取失败，请重新选择'))
    }
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择'))
    reader.readAsDataURL(file)
  })
}

/** 文件名没有扩展名时按图片类型补上，保存时按扩展名识别格式。 */
function imageFileName(file: File, extension: string): string {
  const name = file.name.trim() === '' ? '图片' : file.name.trim()
  return /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.${extension}`
}

interface ToolButtonProps {
  label: string
  onClick: () => void
  pressed?: boolean | undefined
  disabled?: boolean | undefined
  format?: 'bold' | 'italic' | undefined
  children: ReactNode
}

/** 工具栏按钮：点击区不小于 36px，可读名称由 aria-label 提供。 */
function ToolButton(props: ToolButtonProps): ReactElement {
  const { label, onClick, pressed, disabled, format, children } = props
  return (
    <button
      type="button"
      className={css.toolButton}
      aria-label={label}
      aria-pressed={pressed}
      data-format={format}
      disabled={disabled}
      onClick={onClick}>
      {children}
    </button>
  )
}

/** 编辑态工具栏；必须渲染在编辑器上下文内。 */
export function EditorToolbar(): ReactElement {
  const [editor] = useLexicalComposerContext()
  const [state, setState] = useState<ToolbarState>(INITIAL_STATE)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [problem, setProblem] = useState('')
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const refresh = () => {
      editor.getEditorState().read(() => setState($readToolbarState()))
    }
    const removeUpdate = editor.registerUpdateListener(refresh)
    const removeUndo = editor.registerCommand(
      CAN_UNDO_COMMAND,
      (value) => {
        setCanUndo(value)
        return false
      },
      COMMAND_PRIORITY_LOW,
    )
    const removeRedo = editor.registerCommand(
      CAN_REDO_COMMAND,
      (value) => {
        setCanRedo(value)
        return false
      },
      COMMAND_PRIORITY_LOW,
    )
    return () => {
      removeUpdate()
      removeUndo()
      removeRedo()
    }
  }, [editor])

  const setBlock = useCallback(
    (style: BlockStyle) => {
      editor.update(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) $applyBlockStyle(selection, style)
      })
      editor.focus()
    },
    [editor],
  )

  const formatText = useCallback(
    (format: 'bold' | 'italic') => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, format)
      editor.focus()
    },
    [editor],
  )

  const insertTable = useCallback(() => {
    editor.dispatchCommand(INSERT_TABLE_COMMAND, {
      columns: '2',
      rows: '2',
      includeHeaders: { rows: true, columns: false },
    })
    editor.focus()
  }, [editor])

  const undo = useCallback(() => {
    editor.dispatchCommand(UNDO_COMMAND)
    editor.focus()
  }, [editor])

  const redo = useCallback(() => {
    editor.dispatchCommand(REDO_COMMAND)
    editor.focus()
  }, [editor])

  const openImagePicker = useCallback(() => {
    setProblem('')
    fileInput.current?.click()
  }, [])

  const insertImages = useCallback(
    async (files: FileList) => {
      const picked: Array<{ url: string; fileName: string }> = []
      for (const file of Array.from(files)) {
        const extension = SUPPORTED_IMAGE_TYPES.get(file.type)
        if (extension === undefined) {
          setProblem('请选择 PNG、JPEG、GIF、WebP、BMP 或 SVG 图片')
          continue
        }
        if (file.size > MAX_IMAGE_BYTES) {
          setProblem('图片不能超过 20 MB')
          continue
        }
        try {
          picked.push({
            url: await readImageAsDataUrl(file),
            fileName: imageFileName(file, extension),
          })
        } catch {
          setProblem('图片读取失败，请重新选择')
        }
      }
      if (picked.length === 0) return
      editor.update(() => {
        for (const image of picked) {
          $insertNodeToNearestRoot($createImageNode(image.url, image.fileName, image.fileName))
        }
      })
      editor.focus()
    },
    [editor],
  )

  const selectImages = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      event.target.value = ''
      if (files !== null && files.length > 0) void insertImages(files)
    },
    [insertImages],
  )

  return (
    <>
      <div className={css.toolbar} role="toolbar" aria-label="正文格式">
        <div className={css.toolGroup} role="group" aria-label="段落样式">
          {STYLE_OPTIONS.map((option) => (
            <ToolButton
              key={option.style}
              label={option.label}
              pressed={state.block === option.style}
              onClick={() => setBlock(option.style)}>
              {option.label}
            </ToolButton>
          ))}
        </div>
        <div className={css.toolGroup} role="group" aria-label="文字样式">
          <ToolButton
            label="加粗"
            format="bold"
            pressed={state.bold}
            onClick={() => formatText('bold')}>
            加粗
          </ToolButton>
          <ToolButton
            label="斜体"
            format="italic"
            pressed={state.italic}
            onClick={() => formatText('italic')}>
            斜体
          </ToolButton>
        </div>
        <div className={css.toolGroup} role="group" aria-label="列表与引用">
          <ToolButton
            label="无序列表"
            pressed={state.block === 'bulleted'}
            onClick={() => setBlock('bulleted')}>
            列表
          </ToolButton>
          <ToolButton
            label="编号列表"
            pressed={state.block === 'numbered'}
            onClick={() => setBlock('numbered')}>
            编号
          </ToolButton>
          <ToolButton
            label="引用"
            pressed={state.block === 'quote'}
            onClick={() => setBlock('quote')}>
            引用
          </ToolButton>
        </div>
        <div className={css.toolGroup} role="group" aria-label="插入">
          <ToolButton label="插入表格" onClick={insertTable}>
            表格
          </ToolButton>
          <ToolButton label="插入图片" onClick={openImagePicker}>
            图片
          </ToolButton>
        </div>
        <div className={css.toolGroup} role="group" aria-label="撤销与重做">
          <ToolButton label="撤销" disabled={!canUndo} onClick={undo}>
            撤销
          </ToolButton>
          <ToolButton label="重做" disabled={!canRedo} onClick={redo}>
            重做
          </ToolButton>
        </div>
      </div>
      {problem === '' ? null : (
        <p className={css.toolbarProblem} role="alert">
          {problem}
        </p>
      )}
      <input
        ref={fileInput}
        className={css.fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={selectImages}
      />
    </>
  )
}
