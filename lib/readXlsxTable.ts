import { inflateRawSync } from 'zlib'

type ZipEntry = { method: number; compressedSize: number; localOffset: number }

function xmlText(value: string) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
}

function zipDirectory(buffer: Buffer) {
  let end = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break }
  }
  if (end < 0) throw new Error('This file is not a valid XLSX workbook.')
  const entries = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  const directory = new Map<string, ZipEntry>()
  for (let index = 0; index < entries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('The XLSX directory is invalid.')
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    directory.set(name.replace(/\\/g, '/'), { method, compressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return directory
}

function unzipFile(buffer: Buffer, directory: Map<string, ZipEntry>, name: string) {
  const entry = directory.get(name.replace(/^\//, ''))
  if (!entry) throw new Error(`The XLSX workbook is missing ${name}.`)
  const offset = entry.localOffset
  if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('The XLSX file entry is invalid.')
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const compressed = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return compressed.toString('utf8')
  if (entry.method === 8) return inflateRawSync(compressed).toString('utf8')
  throw new Error(`Unsupported XLSX compression method: ${entry.method}.`)
}

function firstWorksheetPath(buffer: Buffer, directory: Map<string, ZipEntry>) {
  const workbook = unzipFile(buffer, directory, 'xl/workbook.xml')
  const relationshipId = workbook.match(/<sheet\b[^>]*\br:id="([^"]+)"/i)?.[1]
  if (!relationshipId) return 'xl/worksheets/sheet1.xml'
  const relationships = unzipFile(buffer, directory, 'xl/_rels/workbook.xml.rels')
  const relationshipPattern = /<Relationship\b([^>]+)\/?\s*>/gi
  for (const match of relationships.matchAll(relationshipPattern)) {
    const attributes = match[1]
    if (attributes.match(/\bId="([^"]+)"/)?.[1] !== relationshipId) continue
    const target = attributes.match(/\bTarget="([^"]+)"/)?.[1]
    if (!target) break
    return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  }
  return 'xl/worksheets/sheet1.xml'
}

function columnIndex(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0].toUpperCase() || 'A'
  let result = 0
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64
  return result - 1
}

export function readXlsxTable(buffer: Buffer): string[][] {
  const directory = zipDirectory(buffer)
  let shared: string[] = []
  if (directory.has('xl/sharedStrings.xml')) {
    const xml = unzipFile(buffer, directory, 'xl/sharedStrings.xml')
    shared = [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map(match =>
      [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(part => xmlText(part[1])).join(''),
    )
  }
  const sheet = unzipFile(buffer, directory, firstWorksheetPath(buffer, directory))
  const rows: string[][] = []
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const row: string[] = []
    let fallbackColumn = 0
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi)) {
      const attributes = cellMatch[1] || cellMatch[3] || ''
      const body = cellMatch[2] || ''
      const reference = attributes.match(/\br="([^"]+)"/i)?.[1]
      const index = reference ? columnIndex(reference) : fallbackColumn
      const type = attributes.match(/\bt="([^"]+)"/i)?.[1]
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? ''
      const inline = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/i)?.[1]
      let value = inline ? xmlText(inline) : xmlText(raw)
      if (type === 's' && /^\d+$/.test(raw)) value = shared[Number(raw)] ?? ''
      row[index] = value
      fallbackColumn = index + 1
    }
    rows.push(row)
  }
  return rows
}
