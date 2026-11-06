/** Workbench copy belongs to the Client locale registry. */
export const zh = {
  title: '本地需求与原型', projects: '项目', open: '打开项目', create: '新建项目', name: '项目名称', cancel: '取消', save: '保存', rename: '重命名', relocate: '重新定位', remove: '从最近移除',
  empty: '选择一个普通文件夹，开始编辑需求与原型。', loading: '正在读取项目…', requirements: '需求', prototype: '原型', knowledge: '知识库', back: '返回项目', chat: 'AI 会话', hideChat: '收起会话', newSession: '新建会话', selectSession: '选择会话', noSession: '创建或选择项目会话。', sessionLoading: '正在恢复会话…', unavailable: '模块未加载', retry: '重试', moved: '重新定位会建立新的项目登记，旧会话仍保留在原目录历史。', chooseParent: '选择父目录', directory: '目录', openFailed: '项目无法打开', unsaved: '当前文档尚未保存', removeNote: '仅移除登记，保留文件与会话历史。',
}
export const en: Record<keyof typeof zh, string> = {
  title: 'Local requirements and prototypes', projects: 'Projects', open: 'Open project', create: 'New project', name: 'Project name', cancel: 'Cancel', save: 'Save', rename: 'Rename', relocate: 'Locate folder', remove: 'Remove from recent',
  empty: 'Choose a folder to work on requirements and prototypes.', loading: 'Loading projects…', requirements: 'Requirements', prototype: 'Prototype', knowledge: 'Knowledge', back: 'Projects', chat: 'AI conversation', hideChat: 'Hide conversation', newSession: 'New conversation', selectSession: 'Select conversation', noSession: 'Create or select a project conversation.', sessionLoading: 'Restoring conversation…', unavailable: 'Module unavailable', retry: 'Retry', moved: 'Locating a folder creates a new project registration. Existing conversations stay in the history of the original folder.', chooseParent: 'Choose parent folder', directory: 'Folder', openFailed: 'Cannot open project', unsaved: 'The current document has unsaved changes', removeNote: 'Only the registration is removed. Files and conversation history are retained.',
}
export type ShellKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { eadpShell: ShellKey }
}
