import {
  IconBrandPython, IconFile, IconFileCode, IconFileDatabase, IconFileMusic, IconFileSpreadsheet, IconFileText, IconFileTypeCsv,
  IconFileTypeCss, IconFileTypeDoc, IconFileTypeHtml, IconFileTypeJpg, IconFileTypeJs, IconFileTypePdf, IconFileTypePng, IconFileTypePpt,
  IconFileTypeRs, IconFileTypeSql, IconFileTypeSvg, IconFileTypeTs, IconFileTypeTxt, IconFileTypeVue, IconFileTypeXls, IconFileTypeXml,
  IconFileTypography, IconFileZip, IconFolderFilled, IconJson, IconMarkdown, IconMovie, IconPhoto, IconPresentation, type Icon,
} from '@tabler/icons-react'
import type { FileEntry } from '@/shared/types'
import { extension, fileType, type FileCategory } from '../lib/format'

const BY_EXTENSION: Record<string, Icon> = {
  pdf: IconFileTypePdf, csv: IconFileTypeCsv, tsv: IconFileTypeCsv, doc: IconFileTypeDoc, docx: IconFileTypeDoc, xls: IconFileTypeXls,
  xlsx: IconFileTypeXls, ppt: IconFileTypePpt, pptx: IconFileTypePpt, jpg: IconFileTypeJpg, jpeg: IconFileTypeJpg, png: IconFileTypePng,
  svg: IconFileTypeSvg, ts: IconFileTypeTs, tsx: IconFileTypeTs, mts: IconFileTypeTs, js: IconFileTypeJs, jsx: IconFileTypeJs, mjs: IconFileTypeJs,
  cjs: IconFileTypeJs, html: IconFileTypeHtml, htm: IconFileTypeHtml, css: IconFileTypeCss, scss: IconFileTypeCss, txt: IconFileTypeTxt,
  sql: IconFileTypeSql, xml: IconFileTypeXml, md: IconMarkdown, mdx: IconMarkdown, json: IconJson, py: IconBrandPython, rs: IconFileTypeRs,
  vue: IconFileTypeVue,
}
const BY_CATEGORY: Record<FileCategory, Icon> = {
  folder: IconFolderFilled, image: IconPhoto, video: IconMovie, audio: IconFileMusic, archive: IconFileZip, code: IconFileCode,
  document: IconFileText, spreadsheet: IconFileSpreadsheet, presentation: IconPresentation, pdf: IconFileTypePdf, data: IconFileDatabase,
  text: IconFileText, font: IconFileTypography, other: IconFile,
}

export function FileIcon({ entry, size = 18 }: { entry: Pick<FileEntry, 'name' | 'kind' | 'uploading'>; size?: number }) {
  const { category } = fileType(entry)
  const Glyph = entry.kind === 'directory' ? IconFolderFilled : BY_EXTENSION[extension(entry)] ?? BY_CATEGORY[category]
  return <span className={`file-icon tone-${category}`} aria-hidden="true"><Glyph size={size} stroke={1.6} /></span>
}
