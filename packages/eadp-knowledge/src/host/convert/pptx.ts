/**
 * PowerPoint（.pptx）解析：jszip 打开 OOXML 容器，fast-xml-parser 按顺序读幻灯片。
 *
 * 每张幻灯片输出二级标题 + 段落；表格与图片不自动整理，只统计并写警告。
 */
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import type { ConvertBlock, ConvertedDocument } from './blocks.ts'
import { diagnosticOf, emptyDocument, parseFailed } from './failure.ts'
import { escapeHeadingText } from './render.ts'

/** fast-xml-parser 顺序模式下的节点；属性在 `:@`，文本在 `#text`。 */
type XmlScalar = string | number | boolean | null | undefined

interface OrderedElement {
  ':@'?: Record<string, XmlScalar>
  '#text'?: XmlScalar
  [tag: string]: XmlScalar | OrderedElement[] | Record<string, XmlScalar> | undefined
}

interface SlideText {
  paragraphs: string[]
  hasTable: boolean
  hasPicture: boolean
}

/** 顺序模式解析器：保留标签顺序，段落才能按原顺序输出。 */
const PARSER = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: true })

function parseXml(xml: string): OrderedElement[] {
  const parsed: OrderedElement[] = PARSER.parse(xml)
  return Array.isArray(parsed) ? parsed : []
}

/** 节点自身的标签名；`:@` 与 `#text` 不是标签。 */
function tagOf(element: OrderedElement): string | undefined {
  return Object.keys(element).find(key => key !== ':@' && key !== '#text')
}

function childrenOf(element: OrderedElement): OrderedElement[] {
  const tag = tagOf(element)
  if (tag === undefined) return []
  const value = element[tag]
  return Array.isArray(value) ? value : []
}

function attribute(element: OrderedElement, name: string): string | undefined {
  const value = element[':@']?.[name]
  return value === undefined || value === null ? undefined : String(value)
}

/** 文本内容在顺序模式里是子节点 `{ '#text': ... }`，按出现顺序拼接。 */
function textOfElement(element: OrderedElement): string {
  let output = ''
  for (const child of childrenOf(element)) {
    const text = child['#text']
    if (typeof text === 'string') output += text
    else if (typeof text === 'number') output += String(text)
  }
  return output
}

/** 访问所有后代节点，按文档顺序。 */
function walk(nodes: readonly OrderedElement[], visit: (tag: string, element: OrderedElement) => void): void {
  for (const node of nodes) {
    const tag = tagOf(node)
    if (tag !== undefined) visit(tag, node)
    walk(childrenOf(node), visit)
  }
}

/** 一个段落内所有文本运行拼成一行。 */
function paragraphText(element: OrderedElement): string {
  const parts: string[] = []
  walk(childrenOf(element), (tag, node) => {
    if (tag === 'a:t') parts.push(textOfElement(node))
  })
  return parts.join('')
}

/** 读取一张幻灯片的文字与“有无表格/图片”标记；表格单元格不当作正文段落。 */
function readSlide(xml: string): SlideText {
  const result: SlideText = { paragraphs: [], hasTable: false, hasPicture: false }
  const visit = (nodes: readonly OrderedElement[]): void => {
    for (const node of nodes) {
      const tag = tagOf(node)
      if (tag === 'a:tbl') {
        result.hasTable = true
        continue
      }
      if (tag === 'p:pic' || tag === 'a:blip') {
        result.hasPicture = true
        continue
      }
      if (tag === 'a:p') {
        const text = paragraphText(node).replace(/\s+/g, ' ').trim()
        if (text !== '') result.paragraphs.push(text)
        continue
      }
      visit(childrenOf(node))
    }
  }
  visit(parseXml(xml))
  return result
}

/** 读取容器内文本文件；缺失时返回 undefined。 */
async function readEntry(zip: JSZip, path: string): Promise<string | undefined> {
  const file = zip.file(path)
  return file === null ? undefined : await file.async('string')
}

/** 从 presentation.xml + rels 取得幻灯片真实顺序；读不到时回退到文件名顺序。 */
async function slidePaths(zip: JSZip): Promise<string[]> {
  const presentation = await readEntry(zip, 'ppt/presentation.xml')
  const relationships = await readEntry(zip, 'ppt/_rels/presentation.xml.rels')
  if (presentation !== undefined && relationships !== undefined) {
    const targets = new Map<string, string>()
    walk(parseXml(relationships), (tag, element) => {
      if (tag !== 'Relationship') return
      const id = attribute(element, '@_Id')
      const target = attribute(element, '@_Target')
      if (id !== undefined && target !== undefined) targets.set(id, target)
    })
    const ordered: string[] = []
    walk(parseXml(presentation), (tag, element) => {
      if (tag !== 'p:sldId') return
      const id = attribute(element, '@_r:id')
      const target = id === undefined ? undefined : targets.get(id)
      if (target !== undefined) ordered.push(target)
    })
    if (ordered.length > 0) return ordered.map(target => target.replace(/^\.\//, '').replace(/^\/+/, ''))
  }
  return Object.keys(zip.files)
    .filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((left, right) => Number(left.match(/slide(\d+)\.xml/)?.[1]) - Number(right.match(/slide(\d+)\.xml/)?.[1]))
}

/** 解析 PPTX 演示文稿。 */
export async function parsePptx(bytes: Uint8Array): Promise<ConvertedDocument> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  }
  catch (error) {
    parseFailed(
      '文件已加密或已损坏，暂时无法整理；可以查看原件、重试或手工整理成文档。',
      `pptx zip open failed: ${diagnosticOf(error)}`,
    )
  }

  const paths = await slidePaths(zip)
  if (paths.length === 0)
    emptyDocument('文件里没有可整理的正文内容，可查看原件、重试或手工整理成文档。', 'pptx contains no slide part')

  const blocks: ConvertBlock[] = []
  let tableSlides = 0
  let pictureSlides = 0
  let emptySlides = 0
  for (let index = 0; index < paths.length; index += 1) {
    const xml = await readEntry(zip, `ppt/${paths[index]}`)
    if (xml === undefined) continue
    const slide = readSlide(xml)
    if (slide.hasTable) tableSlides += 1
    if (slide.hasPicture) pictureSlides += 1
    if (slide.paragraphs.length === 0) {
      emptySlides += 1
      continue
    }
    const slideNumber = index + 1
    const locator = { slide: slideNumber, label: `第 ${slideNumber} 张幻灯片` }
    const [title, ...body] = slide.paragraphs
    blocks.push({ kind: 'heading', level: 2, text: escapeHeadingText(title ?? ''), locator })
    for (const paragraph of body)
      blocks.push({ kind: 'paragraph', text: paragraph, locator })
  }

  const warnings: string[] = []
  if (tableSlides > 0) warnings.push(`有 ${tableSlides} 张幻灯片中的表格未整理，可查看原件。`)
  if (pictureSlides > 0) warnings.push(`有 ${pictureSlides} 张幻灯片中的图片未一并导入，可查看原件。`)
  if (emptySlides > 0) warnings.push(`有 ${emptySlides} 张幻灯片没有可直接读取的文字，可查看原件。`)
  if (blocks.length === 0)
    emptyDocument('文件里没有可整理的正文内容，可查看原件、重试或手工整理成文档。', 'pptx slides contain no readable text')
  return { blocks, warnings }
}
