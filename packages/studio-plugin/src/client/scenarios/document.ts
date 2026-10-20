import type { DiffBlockLabels, MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

export const markdownLabels: MarkdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' }
export const diffLabels: DiffBlockLabels = {
  codeLabel: 'Markdown', wrapLabel: '自动换行', unwrapLabel: '保留行宽', copy: '复制', copied: '已复制',
  collapseAria: '收起差异', expandAria: hidden => `展开 ${hidden} 行差异`, collapse: '收起', expand: hidden => `展开 ${hidden} 行`,
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
