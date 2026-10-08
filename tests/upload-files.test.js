import assert from 'node:assert/strict'
import test from 'node:test'
import { droppedFiles, selectedFiles, uploadDestination } from '../frontend/lib/upload-files.ts'

const fileEntry = file => ({ name: file.name, isFile: true, isDirectory: false, file: resolve => queueMicrotask(() => resolve(file)) })
function directoryEntry(name, children) {
  return { name, isFile: false, isDirectory: true, createReader() {
    let offset = 0
    return { readEntries(resolve) { const batch = children.slice(offset, offset + 100); offset += batch.length; queueMicrotask(() => resolve(batch)) } }
  } }
}
const dropped = entries => ({ items: entries.map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry })), files: [] })

test('folder selections preserve their root and nested paths independently of the basename', () => {
  const first = new File(['one'], 'same.txt'), second = new File(['two'], 'same.txt')
  Object.defineProperty(first, 'webkitRelativePath', { value: 'Project/文档 #1/same.txt' })
  Object.defineProperty(second, 'webkitRelativePath', { value: 'Project/Other/same.txt' })
  const sources = selectedFiles([first, second])
  assert.deepEqual(sources.map(source => uploadDestination(source, '/Incoming').directory), ['/Incoming/Project/文档 #1', '/Incoming/Project/Other'])
  assert.deepEqual(uploadDestination(sources[0], '/').folders, [{ directory: '/', name: 'Project' }, { directory: '/Project', name: '文档 #1' }])
  assert.equal(uploadDestination(selectedFiles([new File([], 'empty.txt')])[0], '/').directory, '/')
})

test('unsafe folder paths, mismatched filenames, and overlong paths are rejected before queueing', () => {
  const file = new File([], 'file.txt')
  for (const relativePath of ['/file.txt', '../file.txt', 'Project/../file.txt', './file.txt', 'Project//file.txt', 'Project\\bad/file.txt', '.FiLeBrowser-state/file.txt', 'Project/\n/file.txt', 'Project/wrong.txt', '文'.repeat(86) + '/file.txt', 'Project/ /file.txt']) {
    assert.throws(() => uploadDestination({ file, relativePath }, '/'), /Invalid upload path/)
  }
  assert.throws(() => uploadDestination({ file, relativePath: 'Project/file.txt' }, '/' + 'a'.repeat(4090)), /too long/)
})

test('dropped directories read every batch, recurse, preserve mixed roots, and skip empty directories', async () => {
  const children = Array.from({ length: 205 }, (_, index) => fileEntry(new File([String(index)], `${index}.txt`)))
  children.push(directoryEntry('Nested', [fileEntry(new File([], 'empty.txt'))]), directoryEntry('Empty', []))
  const loose = new File(['loose'], 'loose.txt')
  const sources = await droppedFiles(dropped([directoryEntry('Project', children), fileEntry(loose)]))
  assert.equal(sources.length, 207)
  assert.equal(sources[204].relativePath, 'Project/204.txt')
  assert.equal(sources[205].relativePath, 'Project/Nested/empty.txt')
  assert.equal(sources[206].relativePath, 'loose.txt')
  assert.equal(await sources[104].file.text(), '104')
  assert.equal(sources[206].file, loose)
})

test('drop entries are captured synchronously, before the data store becomes protected', async () => {
  let readable = true
  const entries = [directoryEntry('A', [fileEntry(new File(['a'], 'a.txt'))]), directoryEntry('B', [fileEntry(new File(['b'], 'b.txt'))])]
  const data = { items: entries.map(entry => ({ kind: 'file', webkitGetAsEntry() { assert.ok(readable); return entry } })), files: [] }
  const promise = droppedFiles(data)
  readable = false
  assert.deepEqual((await promise).map(source => source.relativePath), ['A/a.txt', 'B/b.txt'])
})

test('ordinary dropped files work without entries; unreadable directories fail without returning partial files', async () => {
  const file = new File(['plain'], 'plain.txt')
  assert.deepEqual(await droppedFiles({ items: [], files: [file] }), selectedFiles([file]))
  const broken = { name: 'Broken', isDirectory: true, createReader: () => ({ readEntries: (_resolve, reject) => reject(new Error('Access denied')) }) }
  await assert.rejects(droppedFiles(dropped([fileEntry(file), broken])), /Access denied/)
  await assert.rejects(droppedFiles(dropped([fileEntry(file), null])), /Could not read all dropped items/)
})

test('canceling a directory scan prevents it from yielding files', async () => {
  const controller = new AbortController()
  let finish
  const entry = { name: 'file.txt', isFile: true, file: resolve => { finish = resolve } }
  const promise = droppedFiles(dropped([entry]), controller.signal)
  controller.abort(); finish(new File([], 'file.txt'))
  await assert.rejects(promise, { name: 'AbortError' })
})
