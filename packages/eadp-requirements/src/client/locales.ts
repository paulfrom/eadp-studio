/** Requirement editing copy is supplied through the official locale service. */
export const zh = {
  recreate: '重新创建此文件', discardMissing: '关闭文件并放弃输入',
  title: '需求', empty: '暂无需求文件', refresh: '刷新', create: '新建需求', folder: '新建目录', context: '项目背景', createContext: '创建项目背景', contextAbsent: '项目尚无 CONTEXT.md。', select: '选择需求或项目背景开始编辑。', name: '相对路径', cancel: '取消', confirm: '确定', rename: '改名', remove: '删除', confirmRemove: '确认删除当前文件？删除后不可恢复。', save: '立即保存', saved: '已保存', dirty: '未保存', saving: '正在保存', composing: '正在组字', conflict: '磁盘内容已发生变化，当前输入已保留。', loadDisk: '载入磁盘内容', keepDraft: '保留我的草稿', disk: '当前磁盘内容', missing: '磁盘文件已被删除。', loading: '正在读取…', retry: '重试', error: '操作失败，当前输入已保留。',
}
export const en: Record<keyof typeof zh, string> = {
  recreate: 'Recreate this file', discardMissing: 'Close file and discard input',
  title: 'Requirements', empty: 'No requirement files yet', refresh: 'Refresh', create: 'New requirement', folder: 'New folder', context: 'Project context', createContext: 'Create context', contextAbsent: 'This project has no CONTEXT.md.', select: 'Select a requirement or project context to edit.', name: 'Relative path', cancel: 'Cancel', confirm: 'Confirm', rename: 'Rename', remove: 'Delete', confirmRemove: 'Delete this file permanently?', save: 'Save now', saved: 'Saved', dirty: 'Unsaved', saving: 'Saving', composing: 'Composing', conflict: 'The file changed on disk. Your input is retained.', loadDisk: 'Load disk content', keepDraft: 'Keep my draft', disk: 'Current disk content', missing: 'The file was deleted from disk.', loading: 'Loading…', retry: 'Retry', error: 'The operation failed. Your input is retained.',
}
export const NS = 'eadp.requirements'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'eadp.requirements': keyof typeof zh } }
