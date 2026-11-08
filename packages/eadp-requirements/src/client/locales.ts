/** Requirement editing copy is supplied through the official locale service. */
export const zh = {
  title: '材料', context: '项目背景', create: '新建需求', folder: '新建目录', refresh: '刷新', empty: '暂无需求文件', loading: '正在读取…',
  select: '选择需求或项目背景开始编辑。', contextAbsent: '项目尚无 CONTEXT.md。', createContext: '创建项目背景',
  name: '相对路径', nameHint: '未写需求目录时自动归入，文件自动追加 .md 后缀。', cancel: '取消', confirm: '确定', rename: '改名', remove: '删除', confirmRemove: '删除后不可恢复。确定删除？',
  moreActions: '更多操作', fileActions: '文件操作', directoryActions: '目录操作', operationFailed: '操作失败',
  composing: '正在组字', applyingProposal: '正在应用提案', saving: '正在保存', dirty: '未保存', saved: '已保存', save: '立即保存', placeholder: '开始撰写材料…',
  find: '查找', findPrevious: '上一处', findNext: '下一处', close: '关闭',
  flushComposing: '正在组字，结束组字后再继续。', flushConflict: '文件已在磁盘上变化，请先处理冲突。', flushMissing: '文件已被删除，请先处理缺失提示。', flushSaving: '正在保存，请稍后再试。', flushFailed: '输入尚未保存，请处理后重试。',
  conflict: '磁盘内容已发生变化，当前输入已保留。', loadDisk: '载入磁盘内容', keepDraft: '保留我的草稿', disk: '当前磁盘内容',
  missing: '磁盘文件已被删除。', recreate: '重新创建此文件', discardMissing: '关闭文件并放弃输入', draftRetained: '提案已写入磁盘，应用期间输入已保留为草稿。',
  words: '字', lines: '行', version: '版本', newFile: '新文件',
  proposals: 'AI 修改提案', proposalMemory: '未应用提案只保留在当前进程', noProposals: '暂无待审阅提案', staleProposal: '基于旧版本，请重新生成', basedOn: '基于版本',
  reviewDiff: '查看行级差异', candidateText: '完整候选正文', diffTruncated: '差异过长，已截断；应用前可查看完整候选正文。', applyProposal: '应用', discardProposal: '丢弃',
  prepareFailed: '请先保存输入、结束组字或处理文件冲突。', expand: '展开', collapse: '收起',
}
export const en: Record<keyof typeof zh, string> = {
  title: 'Materials', context: 'Project context', create: 'New requirement', folder: 'New folder', refresh: 'Refresh', empty: 'No requirement files yet', loading: 'Loading…',
  select: 'Select a requirement or the project context to start editing.', contextAbsent: 'This project has no CONTEXT.md.', createContext: 'Create project context',
  name: 'Relative path', nameHint: 'Bare names are placed in the requirement directory; files get a .md suffix.', cancel: 'Cancel', confirm: 'Confirm', rename: 'Rename', remove: 'Delete', confirmRemove: 'This cannot be undone. Delete it?',
  moreActions: 'More actions', fileActions: 'File actions', directoryActions: 'Directory actions', operationFailed: 'The operation failed',
  composing: 'Composing', applyingProposal: 'Applying proposal', saving: 'Saving', dirty: 'Unsaved', saved: 'Saved', save: 'Save now', placeholder: 'Start writing…',
  find: 'Find', findPrevious: 'Previous match', findNext: 'Next match', close: 'Close',
  flushComposing: 'Finish composing before continuing.', flushConflict: 'The file changed on disk. Resolve the conflict first.', flushMissing: 'The file was deleted. Handle the missing-file notice first.', flushSaving: 'Saving; try again shortly.', flushFailed: 'Your input is not saved yet; resolve the failure and retry.',
  conflict: 'The file changed on disk. Your input is retained.', loadDisk: 'Load disk content', keepDraft: 'Keep my draft', disk: 'Current disk content',
  missing: 'The file was deleted from disk.', recreate: 'Recreate this file', discardMissing: 'Close file and discard input', draftRetained: 'The proposal was written; input typed during the update was kept as a draft.',
  words: 'words', lines: 'lines', version: 'Version', newFile: 'New file',
  proposals: 'AI proposals', proposalMemory: 'Unapplied proposals stay in this process only', noProposals: 'No proposals to review', staleProposal: 'Based on an older version; regenerate', basedOn: 'Base version',
  reviewDiff: 'Review line changes', candidateText: 'Full candidate text', diffTruncated: 'The diff is truncated. Review the full candidate before applying.', applyProposal: 'Apply', discardProposal: 'Discard',
  prepareFailed: 'Save your input, finish composing, or resolve the file conflict first.', expand: 'Expand', collapse: 'Collapse',
}
export const NS = 'eadp.requirements'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'eadp.requirements': keyof typeof zh } }
