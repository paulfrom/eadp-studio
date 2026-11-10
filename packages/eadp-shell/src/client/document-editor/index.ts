/**
 * 知识正文编辑器的公开入口；知识面板只从这里取组件与类型。
 */
export { MarkdownEditor } from './markdown-editor.tsx'
export type {
  EditorSavePayload,
  MarkdownEditorHandle,
  MarkdownEditorProps,
} from './markdown-editor.tsx'

/** Structures without a corresponding editor node must stay in source editing. */
export function supportsRichEditing(markdown: string): boolean {
  if (/!\[[^\]]*\]\(data:/i.test(markdown)) return false
  if (/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.test(markdown)) return false
  return !/^(?:[ \t]*<[^>]+>|[ \t]*\$\$|\[\^[^\]]+\]:|[ \t]*:::|[ \t]*\[[^\]]+\]:)/m.test(markdown)
    && !/\[\^[^\]]+\]|\$[^$\n]+\$|\[.*?\]\[[^\]]*\]/.test(markdown)
}
