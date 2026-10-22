import type { DiffBlockLabels, MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

export const markdownLabels: MarkdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' }
export const diffLabels: DiffBlockLabels = {
  codeLabel: 'Markdown', wrapLabel: '自动换行', unwrapLabel: '保留行宽', copy: '复制', copied: '已复制',
  collapseAria: '收起差异', expandAria: hidden => `展开 ${hidden} 行差异`, collapse: '收起', expand: hidden => `展开 ${hidden} 行`,
}

export interface DocumentSection { title: string; body: string }
/**
 * Split a scenario body into its `##` business sections so the spec panel can
 * render one card per section instead of one long document. Content before the
 * first section keeps an empty title, and a leading `#` title line is dropped
 * because the document title lives in the material frontmatter.
 * @param markdown - Material body exactly as stored in the draft.
 * @returns One entry per section, in document order; fenced code is never a heading.
 */
export function splitSections(markdown: string): DocumentSection[] {
  const sections: DocumentSection[] = []
  let fence: string | undefined
  let title = '', lines: string[] = [], started = false
  const flush = () => {
    const body = lines.join('\n').trim()
    if (title || body) sections.push({ title, body })
    lines = []
  }
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
    } else if (!fence) {
      const heading = /^ {0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)?.[1]?.trim()
      if (heading) { flush(); title = heading; started = true; continue }
      if (!started && /^ {0,3}#[ \t]/.test(line)) continue
    }
    lines.push(line)
  }
  flush()
  return sections
}

/**
 * Count the list entries of one section so its card can show the entry count
 * instead of repeating the whole list in the header.
 * @param markdown - Section body.
 * @returns Number of top-level list lines outside fenced code.
 */
export function listItemCount(markdown: string): number {
  let fence: string | undefined, count = 0
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; continue }
    if (!fence && /^ {0,3}(?:[-*+]|\d+[.)])[ \t]+\S/.test(line)) count += 1
  }
  return count
}

export function exportMarkdown(title: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = `${title.replace(/[\\/:*?"<>|]/g, '_') || '场景'}.md`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function fileBase64(file: File): Promise<string> {
  if (file.size > 24_000_000) return Promise.reject(new Error('资料文件不能超过 24 MB。'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('资料文件读取失败，请重试。'))
    reader.readAsDataURL(file)
  })
}

export async function readTemplateFile(file: File): Promise<string> {
  if (file.size > 1_000_000) throw new Error('模板文件不能超过 1 MB。')
  return (await file.text()).replace(/\r\n?/g, '\n')
}
