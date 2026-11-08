/**
 * 正文里的图片节点。图片以真实图片显示，正文文本里保存的仍是图片引用；
 * 编辑态与阅读态共用一个节点类型，因此两者排版保持一致。
 */

import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactElement } from 'react'
import css from './editor.module.css'

/** 图片节点序列化到编辑器状态 JSON 的结构，仅用于复制粘贴等内部往返。 */
export interface SerializedImageNode extends SerializedLexicalNode {
  url: string
  fileName: string
  alt: string
}

const IMAGE_NODE_TYPE = 'eadp-knowledge-image'

/**
 * 块级图片节点：显示地址、原始文件名和替代文字。
 * 显示地址在载入时由相对引用替换而来，导出时再还原为相对引用或新资源占位。
 */
export class ImageNode extends DecoratorNode<ReactElement> {
  /** 可直接用于 <img> 的地址：图片资源地址、data URL 或外部地址。 */
  __url: string
  /** 用户选择图片时的文件名，保存新图片资源时沿用。 */
  __fileName: string
  /** 替代文字，同时用于纯文本复制与无障碍阅读。 */
  __alt: string

  static override getType(): string {
    return IMAGE_NODE_TYPE
  }

  static override clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__url, node.__fileName, node.__alt, node.__key)
  }

  static override importJSON(serialized: SerializedLexicalNode & Record<string, unknown>): ImageNode {
    return $createImageNode(readText(serialized.url), readText(serialized.fileName), readText(serialized.alt))
  }

  constructor(url: string, fileName: string, alt: string, key?: NodeKey) {
    super(key)
    this.__url = url
    this.__fileName = fileName
    this.__alt = alt
  }

  /** 当前显示地址；新插入图片是 data URL，已有图片是资源显示地址。 */
  getUrl(): string {
    return this.getLatest().__url
  }

  /** 原始文件名，只在把新图片保存为资料资源时使用。 */
  getFileName(): string {
    return this.getLatest().__fileName
  }

  /** 替代文字；导出图片引用时作为方括号里的说明。 */
  getAlt(): string {
    return this.getLatest().__alt
  }

  override createDOM(): HTMLElement {
    const element = document.createElement('div')
    element.className = css.imageBlock ?? ''
    return element
  }

  override updateDOM(): false {
    return false
  }

  override isInline(): false {
    return false
  }

  override getTextContent(): string {
    return this.__alt
  }

  override decorate(): ReactElement {
    return <img className={css.image} src={this.__url} alt={this.__alt} draggable={false} contentEditable={false} />
  }

  override exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      type: IMAGE_NODE_TYPE,
      version: 1,
      url: this.__url,
      fileName: this.__fileName,
      alt: this.__alt,
    }
  }
}

/** 复制粘贴等外部写回的 JSON 只信任字符串字段。 */
function readText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 创建图片节点；不传 key，由编辑器分配。 */
export function $createImageNode(url: string, fileName: string, alt: string): ImageNode {
  return new ImageNode(url, fileName, alt)
}

/** 判断节点是否为图片节点。 */
export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
  return node instanceof ImageNode
}
