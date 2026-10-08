import assert from 'node:assert/strict'
import test from 'node:test'
import { extension, fileType, previewKind } from '../frontend/lib/format.ts'

const entry = (name, size = 0) => ({ name, path: '/' + name, kind: 'file', size, modifiedAt: new Date(0).toISOString() })

test('file types strip synthetic suffixes only for managed unfinished uploads', () => {
  const ordinary = entry('photo.PNG.uploading'), pending = { ...ordinary, uploading: true }
  assert.equal(extension(ordinary), 'uploading')
  assert.equal(fileType(ordinary).category, 'other')
  assert.equal(extension(pending), 'png')
  assert.equal(fileType(pending).category, 'image')
  assert.equal(extension(entry('.env')), '')
  assert.equal(fileType(entry('file.uploading')).label, 'UPLOADING file')
  assert.equal(previewKind(ordinary), null)
  assert.equal(previewKind(pending), null)
})

test('text preview boundaries and pending files match the API policy', () => {
  assert.equal(previewKind(entry('notes.TXT', 1024 * 1024)), 'text')
  assert.equal(previewKind(entry('notes.txt', 1024 * 1024 + 1)), null)
  assert.equal(previewKind(entry('program.exe', 10)), null)
  assert.equal(previewKind({ ...entry('notes.txt', 10), uploading: true }), null)
  assert.equal(previewKind({ ...entry('notes.txt'), kind: 'directory' }), null)
})
