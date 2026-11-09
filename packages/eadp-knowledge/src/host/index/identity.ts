/**
 * 索引身份：内容字段 hash、资料键与 chunk 稳定身份。
 *
 * 词项、切片、数据库与 Host 侧核验共用这里的定义，避免同一身份出现多种算法。
 */
import { createHash } from 'node:crypto'

/** sha256 十六进制小写；字符串按 UTF-8 计。 */
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** 标签身份：标签变化只更新依赖标签的索引视图，正文块可复用。 */
export const tagsHashOf = (tags: readonly string[]): string => sha256(tags.join('\u0000'))

/** 资料键：查找准入集合与索引状态共用，形如 `user:<documentId>`。 */
export const documentKey = (packId: string, documentId: string): string => `${packId}:${documentId}`

/** chunk 稳定身份：正文身份 + 真实范围 + 内容 hash，不依赖资料内序号。 */
export const chunkKeyOf = (bodyHash: string, start: number, end: number, contentHash: string): string =>
  sha256([bodyHash, String(start), String(end), contentHash].join('\n'))
