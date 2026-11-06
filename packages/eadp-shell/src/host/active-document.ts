/** Holds active relative document paths for prompt context, never file authorization. */
export class ActiveDocuments {
  private readonly paths = new Map<string, string>()

  set(projectId: string, value: string | null): void {
    if (value === null) { this.paths.delete(projectId); return }
    if (value !== 'CONTEXT.md' && (!value.startsWith('需求/') || !value.endsWith('.md'))) {
      throw new Error('活动文档必须是需求 Markdown 或 CONTEXT.md。')
    }
    if (value.includes('\\') || /[\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('活动文档路径无效。')
    }
    this.paths.set(projectId, value)
  }

  get(projectId: string): string | undefined { return this.paths.get(projectId) }
}
