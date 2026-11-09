import type { KnowledgeTurnReferenceView } from '@eadp/contracts/knowledge'

/**
 * 需求会话最近一轮自动参考记录的内存持有者。
 * 只保留内存中的当前一轮：新一轮开始会替换上一轮，完成结果必须仍属于同一轮才写入，
 * 迟到或已切换轮次的结果不会覆盖当前记录。
 */
export class TurnReferences {
  private readonly views = new Map<string, KnowledgeTurnReferenceView>()

  /**
   * 开始新一轮记录（关闭、正在查找等起始状态）；同一会话只保留最近一轮。
   * @param view - 本轮已绑定的项目／需求／会话／turn 与起始状态。
   */
  begin(view: KnowledgeTurnReferenceView): void {
    this.views.set(view.sessionId, view)
  }

  /**
   * 写入本轮完成状态；记录已被新一轮替换或 turn 不一致时不写入。
   * @param view - 本轮完成后的实际结果。
   * @returns 是否写入了当前记录。
   */
  settle(view: KnowledgeTurnReferenceView): boolean {
    const existing = this.views.get(view.sessionId)
    if (existing === undefined) return false
    if (existing.turn !== view.turn || existing.turnStartSeq !== view.turnStartSeq) return false
    this.views.set(view.sessionId, view)
    return true
  }

  /**
   * 最近一轮记录；该会话没有记录时为空。
   * @param sessionId - 需求会话标识。
   */
  last(sessionId: string): KnowledgeTurnReferenceView | null {
    return this.views.get(sessionId) ?? null
  }
}
