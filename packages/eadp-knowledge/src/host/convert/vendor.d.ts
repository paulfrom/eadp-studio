/**
 * 第三方库的类型声明补充。
 *
 * turndown 7 与 @joplin/turndown-plugin-gfm 只发布 CJS 产物、不带类型声明；
 * 这里只声明本模块实际用到的 API 面，不复制上游全部行为。
 */
declare module 'turndown' {
  /** turndown 规则回调里能访问到的最小 DOM 节点面。 */
  export interface TurndownNode {
    nodeName: string
    outerHTML: string
    textContent: string
    getAttribute(name: string): string | null
  }

  export type TurndownFilter = string | readonly string[] | ((node: TurndownNode) => boolean)

  export interface TurndownRule {
    filter: TurndownFilter
    replacement: (content: string, node: TurndownNode) => string
  }

  export interface TurndownOptions {
    headingStyle?: 'setext' | 'atx'
    hr?: string
    bulletListMarker?: '-' | '+' | '*'
    codeBlockStyle?: 'indented' | 'fenced'
    fence?: string
    emDelimiter?: '_' | '*'
    strongDelimiter?: '__' | '**'
    linkStyle?: 'inlined' | 'referenced'
    br?: string
    preformattedCode?: boolean
  }

  export type TurndownPlugin = (service: TurndownService) => void

  export default class TurndownService {
    constructor(options?: TurndownOptions)
    use(plugin: TurndownPlugin | TurndownPlugin[]): this
    addRule(key: string, rule: TurndownRule): this
    keep(filter: TurndownFilter): this
    remove(filter: TurndownFilter): this
    turndown(input: string): string
  }
}

declare module '@joplin/turndown-plugin-gfm' {
  import type { TurndownPlugin } from 'turndown'

  interface GfmPlugin {
    gfm: TurndownPlugin
    tables: TurndownPlugin
    strikethrough: TurndownPlugin
    taskListItems: TurndownPlugin
  }

  const plugin: GfmPlugin
  export default plugin
}
