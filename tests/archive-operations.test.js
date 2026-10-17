import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { pack } from 'tar-stream'
import { ZipFile } from 'yazl'
import { createApp } from '../backend/app.ts'
import { LocalStorage } from '../backend/storage/local.ts'
import { localTarget, firstTarget } from './fixtures/targets.js'
import { CHUNK_SIZE, FULL_PERMISSIONS } from '../shared/types.ts'

const password = 'archive-operation-fixture-password'
const sevenAvailable = spawnSync(process.env.FB_7ZIP_PATH || '7zz', ['i']).status === 0
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-archive-operations-')), files = join(root, 'files'), state = join(root, 'state')
  await mkdir(join(files, 'team', 'empty'), { recursive: true })
  for (const name of ['notes.txt', '文件.txt', '@list.txt', '[x]*?.txt', '-option.txt']) await writeFile(join(files, 'team', name), 'content: ' + name)
  await writeFile(join(files, 'team', 'zero'), '')
  await writeFile(join(files, 'extra.bin'), Buffer.from([0, 1, 255, 128]))
  let app = await createApp({ stateDirectory: state, ...options }), url = await app.listen({ host: '127.0.0.1', port: 0 }), cookie = ''
  const request = (path, method = 'GET', body, auth = cookie) => fetch(url + '/api' + path, { method, headers: { cookie: auth, 'x-filebrowser-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  const setup = await request('/setup', 'POST', { username: 'admin', password, siteName: 'Archive operations', target: localTarget(files) })
  assert.equal(setup.status, 201, await setup.clone().text()); cookie = setup.headers.get('set-cookie').split(';')[0]
  const targetId = await firstTarget(request)
  const start = async (type, input) => {
    const response = await request('/operations', 'POST', { type, input: { targetId, directory: '/', ...input } })
    assert.equal(response.status, 202, await response.clone().text())
    return response.json()
  }
  const wait = async (id, predicate = job => job.status !== 'running', auth = cookie) => {
    const until = Date.now() + 20_000
    while (Date.now() < until) {
      const jobs = await (await request('/operations', 'GET', undefined, auth)).json(), job = jobs.find(job => job.id === id)
      if (job && predicate(job)) return job
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Archive operation timed out: ' + id)
  }
  return { root, files, state, request, start, wait, targetId, get cookie() { return cookie },
    async restart(edit) { await app.close(); await edit?.(); app = await createApp({ stateDirectory: state, ...options }); url = await app.listen({ host: '127.0.0.1', port: 0 }) },
  }
}

for (const format of ['tar', 'tar.gz', 'zip', '7z']) test(`${format}: dedicated stored archive round-trip preserves mixed selection, Unicode, literal wildcard names and empty entries`, { skip: format === '7z' && !sevenAvailable }, async t => {
  const f = await fixture(t)
  const compressed = await f.start('archive.compress', { paths: ['/team', '/team/notes.txt', '/extra.bin'], format, name: 'selection.' + format })
  const done = await f.wait(compressed.id)
  assert.equal(done.status, 'completed', done.error); assert.equal(done.progress, 1)
  const decompressed = await f.start('archive.decompress', { paths: ['/selection.' + format], name: 'restored' })
  const extracted = await f.wait(decompressed.id)
  assert.equal(extracted.status, 'completed', extracted.error)
  for (const name of ['notes.txt', '文件.txt', '@list.txt', '[x]*?.txt', '-option.txt', 'zero']) assert.deepEqual(await readFile(join(f.files, 'restored', 'team', name)), await readFile(join(f.files, 'team', name)))
  assert.deepEqual(await readdir(join(f.files, 'restored', 'team', 'empty')), [])
  assert.deepEqual(await readFile(join(f.files, 'restored', 'extra.bin')), Buffer.from([0, 1, 255, 128]))
  assert.deepEqual(await readdir(join(f.state, 'operations-work')), [])
  assert.deepEqual((await readdir(join(f.files, '.filebrowser-uploads'))).filter(name => /^[a-f0-9-]{36}$/.test(name)), [])
  const existing = await f.request('/operations', 'POST', { type: 'archive.decompress', input: { targetId: f.targetId, paths: ['/selection.' + format], directory: '/', name: 'restored' } })
  assert.equal(existing.status, 409)
  // The separate download API keeps its original TAR response.
  const download = await f.request(`/targets/${f.targetId}/files/archive?path=/team`)
  assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/x-tar'); await download.arrayBuffer()
})

async function tarBytes(headers) {
  const tar = pack(), chunks = []
  const reading = (async () => { for await (const bytes of tar) chunks.push(bytes) })()
  for (const header of headers) tar.entry({ size: 1, ...header }, header.type && header.type !== 'file' ? undefined : 'x')
  tar.finalize(); await reading; return Buffer.concat(chunks)
}
async function zipBytes(options = {}) {
  const zip = new ZipFile(), chunks = []
  const reading = (async () => { for await (const bytes of zip.outputStream) chunks.push(bytes) })()
  zip.addBuffer(Buffer.from('zip data'), 'good.txt', options); zip.end(); await reading
  return Buffer.concat(chunks)
}

test('unsafe TAR paths, links, duplicates, ZIP symlinks and corrupt CRCs fail without publishing a destination', async t => {
  const f = await fixture(t)
  const corrupt = await zipBytes(), central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); corrupt[central + 16] ^= 1
  const badZipPath = Buffer.from((await zipBytes()).toString('latin1').replaceAll('good.txt', '../x.txt'), 'latin1')
  const examples = [
    ['traversal.tar', await tarBytes([{ name: '../escape' }])],
    ['absolute.tar', await tarBytes([{ name: '/escape' }])],
    ['symlink.tar', await tarBytes([{ name: 'escape', type: 'symlink', size: 0, linkname: '../../escape' }])],
    ['duplicate.tar', await tarBytes([{ name: 'same' }, { name: 'same' }])],
    ['prefix.tar', await tarBytes([{ name: 'file' }, { name: 'file/child' }])],
    ['link.zip', await zipBytes({ mode: 0o120777 })],
    ['corrupt.zip', corrupt], ['traversal.zip', badZipPath], ['broken.tar.gz', Buffer.from('broken gzip')],
  ]
  for (const [name, bytes] of examples) {
    await writeFile(join(f.files, name), bytes)
    const job = await f.start('archive.decompress', { paths: ['/' + name], name: 'output' })
    const result = await f.wait(job.id)
    assert.equal(result.status, 'failed', name); assert.ok(result.error, name)
    await assert.rejects(readFile(join(f.files, 'output', 'escape')), { code: 'ENOENT' })
    assert.ok(!(await readdir(f.files)).includes('output'), name)
  }
  assert.deepEqual(await readdir(join(f.state, 'operations-work')), [])
})

test('expanded byte and entry limits reject compressed bombs before publishing', async t => {
  const f = await fixture(t, { archiveMaxBytes: 4096, archiveMaxEntries: 3 })
  const tar = pack(), chunks = [], reading = (async () => { for await (const bytes of tar) chunks.push(bytes) })()
  tar.entry({ name: 'huge', size: 10000 }, Buffer.alloc(10000)); tar.finalize(); await reading
  await writeFile(join(f.files, 'bomb.tar.gz'), gzipSync(Buffer.concat(chunks)))
  const job = await f.start('archive.decompress', { paths: ['/bomb.tar.gz'], name: 'output' })
  assert.match((await f.wait(job.id)).error, /limit/)
  const many = await f.start('archive.compress', { paths: ['/team'], name: 'many.zip', format: 'zip' })
  assert.match((await f.wait(many.id)).error, /limit/)
  assert.ok(!(await readdir(f.files)).includes('output'))
})

test('7z extraction rejects symbolic links and encrypted headers without creating archive paths', { skip: !sevenAvailable }, async t => {
  const f = await fixture(t), binary = process.env.FB_7ZIP_PATH || '7zz'
  const input = join(f.root, 'native-input'); await mkdir(input)
  await symlink('../../escape', join(input, 'link'))
  assert.equal(spawnSync(binary, ['a', '-snl', '-t7z', join(f.files, 'links.7z'), '.'], { cwd: input }).status, 0)
  assert.equal(spawnSync(binary, ['a', '-psecret', '-mhe=on', '-t7z', join(f.files, 'encrypted.7z'), join(f.files, 'extra.bin')]).status, 0)
  for (const name of ['links.7z', 'encrypted.7z']) {
    const job = await f.start('archive.decompress', { paths: ['/' + name], name: 'unsafe-output' })
    assert.equal((await f.wait(job.id)).status, 'failed')
    assert.ok(!(await readdir(f.files)).includes('unsafe-output'))
  }
})

test('permission revocation interrupts an archive job even when its source is stalled', async t => {
  const f = await fixture(t)
  const response = await f.request('/admin/users', 'POST', { username: 'revoked', password, role: 'user', disabled: false, grants: [{ targetId: f.targetId, scope: '/team', permissions: FULL_PERMISSIONS }] })
  assert.equal(response.status, 201); const member = await response.json()
  const login = await f.request('/auth/login', 'POST', { username: 'revoked', password }), cookie = login.headers.get('set-cookie').split(';')[0]
  const original = LocalStorage.prototype.open; let stalled
  LocalStorage.prototype.open = async function(path, ...args) {
    if (path === '/team/notes.txt') { stalled = new Readable({ read() {} }); return stalled }
    return original.call(this, path, ...args)
  }
  t.after(() => { LocalStorage.prototype.open = original })
  const started = await f.request('/operations', 'POST', { type: 'archive.compress', input: { targetId: f.targetId, paths: ['/notes.txt'], directory: '/', name: 'revoked.zip', format: 'zip' } }, cookie)
  assert.equal(started.status, 202); const job = await started.json()
  await f.wait(job.id, job => job.phase === 'Compressing', cookie)
  assert.equal((await f.request('/admin/users/' + member.id, 'PATCH', { username: member.username, role: 'user', disabled: false, grants: [{ targetId: f.targetId, scope: '/team', permissions: { ...FULL_PERMISSIONS, upload: false } }] })).status, 200)
  const renewed = await f.request('/auth/login', 'POST', { username: 'revoked', password }), renewedCookie = renewed.headers.get('set-cookie').split(';')[0]
  const result = await f.wait(job.id, undefined, renewedCookie)
  assert.equal(result.status, 'failed'); assert.match(result.error, /permission/); assert.equal(stalled.destroyed, true)
  assert.ok(!(await readdir(join(f.files, 'team'))).includes('revoked.zip'))
})

test('running jobs reserve paths, cancel stalled sources promptly, release resources and persist completed history', async t => {
  const f = await fixture(t)
  const original = LocalStorage.prototype.open
  let stalled
  LocalStorage.prototype.open = async function(path, ...args) {
    if (path === '/team/notes.txt') { stalled = new Readable({ read() {} }); return stalled }
    return original.call(this, path, ...args)
  }
  t.after(() => { LocalStorage.prototype.open = original })
  const job = await f.start('archive.compress', { paths: ['/team/notes.txt'], name: 'pending.zip', format: 'zip' })
  await f.wait(job.id, job => job.phase === 'Compressing')
  const rename = await f.request(`/targets/${f.targetId}/files`, 'PATCH', { path: '/team', name: 'moved' })
  assert.equal(rename.status, 409)
  const upload = await f.request('/uploads', 'POST', { targetId: f.targetId, name: 'pending.zip', directory: '/', size: 0, lastModified: 0, chunkSize: CHUNK_SIZE, hashes: [] })
  assert.equal(upload.status, 409)
  assert.equal((await f.request(`/operations/${job.id}`, 'DELETE')).status, 409)
  assert.deepEqual(await (await f.request('/operations', 'DELETE')).json(), { clearedIds: [] })
  const cancel = await f.request(`/operations/${job.id}/cancel`, 'POST')
  assert.equal(cancel.status, 200); assert.equal((await cancel.json()).status, 'canceled'); assert.equal(stalled.destroyed, true)
  LocalStorage.prototype.open = original
  const next = await f.start('archive.compress', { paths: ['/team/notes.txt'], name: 'next.zip', format: 'zip' })
  assert.equal((await f.wait(next.id)).status, 'completed')
  await f.restart(async () => {
    const db = new DatabaseSync(join(f.state, 'filebrowser.sqlite'))
    const data = JSON.parse(db.prepare('SELECT data FROM operations WHERE id=?').get(job.id).data)
    data.status = 'running'; db.prepare('UPDATE operations SET data=? WHERE id=?').run(JSON.stringify(data), job.id); db.close()
    await mkdir(join(f.state, 'operations-work', job.id)); await writeFile(join(f.state, 'operations-work', job.id, 'leftover'), 'scratch')
  })
  assert.equal((await f.wait(next.id)).status, 'completed')
  assert.match((await f.wait(job.id)).error, /restarted/)
  assert.deepEqual(await readdir(join(f.state, 'operations-work')), [])
})

test('scoped permissions, job ownership, unfinished uploads and read-only targets are enforced', async t => {
  const f = await fixture(t)
  const response = await f.request('/admin/users', 'POST', { username: 'member', password, role: 'user', disabled: false, grants: [{ targetId: f.targetId, scope: '/team', permissions: FULL_PERMISSIONS }] })
  assert.equal(response.status, 201); const member = await response.json()
  const login = await f.request('/auth/login', 'POST', { username: 'member', password }), cookie = login.headers.get('set-cookie').split(';')[0]
  const own = await f.request('/operations', 'POST', { type: 'archive.compress', input: { targetId: f.targetId, paths: ['/notes.txt'], directory: '/', name: 'member.zip', format: 'zip' } }, cookie)
  assert.equal(own.status, 202); const job = await own.json()
  assert.equal((await f.wait(job.id, undefined, cookie)).status, 'completed')
  assert.ok((await readdir(join(f.files, 'team'))).includes('member.zip'))
  assert.equal((await f.request(`/operations/${job.id}/cancel`, 'POST')).status, 404)
  assert.equal((await f.request(`/operations/${job.id}`, 'DELETE')).status, 404)
  assert.deepEqual(await (await f.request('/operations', 'DELETE')).json(), { clearedIds: [] })
  assert.deepEqual(await (await f.request('/operations')).json(), [])
  const traversal = await f.request('/operations', 'POST', { type: 'archive.compress', input: { targetId: f.targetId, paths: ['/../extra.bin'], directory: '/', name: 'bad.zip', format: 'zip' } }, cookie)
  assert.equal(traversal.status, 400)
  assert.equal((await f.request('/admin/users/' + member.id, 'PATCH', { username: member.username, role: member.role, disabled: false, grants: [{ targetId: f.targetId, scope: '/team', permissions: { ...FULL_PERMISSIONS, upload: false } }] })).status, 200)
  const renewed = await f.request('/auth/login', 'POST', { username: 'member', password }), deniedCookie = renewed.headers.get('set-cookie').split(';')[0]
  assert.equal((await f.request('/operations', 'POST', { type: 'archive.compress', input: { targetId: f.targetId, paths: ['/notes.txt'], directory: '/', name: 'denied.zip', format: 'zip' } }, deniedCookie)).status, 403)
  const pending = await f.request('/uploads', 'POST', { targetId: f.targetId, name: 'pending', directory: '/team', size: 0, lastModified: 0, chunkSize: CHUNK_SIZE, hashes: [] })
  assert.equal(pending.status, 201)
  assert.equal((await f.request('/operations', 'POST', { type: 'archive.compress', input: { targetId: f.targetId, paths: ['/team'], directory: '/', name: 'busy.zip', format: 'zip' } })).status, 409)
  const targets = await (await f.request('/admin/targets')).json(), target = targets[0]
  const updated = await f.request('/admin/targets/' + target.id, 'PATCH', { name: target.name, connection: target.connection, enabled: true, readOnly: true })
  assert.equal(updated.status, 200)
  assert.equal((await f.request('/operations', 'POST', { type: 'archive.compress', input: { targetId: f.targetId, paths: ['/extra.bin'], directory: '/', name: 'readonly.zip', format: 'zip' } })).status, 403)
})

test('clearing operations removes only owner task metadata and persists without deleting output', async t => {
  const f = await fixture(t)
  const compressed = await f.start('archive.compress', { paths: ['/team'], name: 'kept.zip', format: 'zip' })
  assert.equal((await f.wait(compressed.id)).status, 'completed')
  const before = await readFile(join(f.files, 'kept.zip'))
  const restored = await f.start('archive.decompress', { paths: ['/kept.zip'], name: 'kept-folder' })
  assert.equal((await f.wait(restored.id)).status, 'completed')
  await writeFile(join(f.files, 'broken.zip'), 'Invalid archive')
  const failed = await f.start('archive.decompress', { paths: ['/broken.zip'], name: 'failed-folder' })
  assert.equal((await f.wait(failed.id)).status, 'failed')
  assert.deepEqual(await (await f.request(`/operations/${compressed.id}`, 'DELETE')).json(), { clearedIds: [compressed.id] })
  assert.deepEqual(new Set((await (await f.request('/operations', 'DELETE')).json()).clearedIds), new Set([restored.id, failed.id]))
  await f.restart()
  assert.deepEqual(await (await f.request('/operations')).json(), [])
  assert.deepEqual(await readFile(join(f.files, 'kept.zip')), before)
  assert.deepEqual(await readFile(join(f.files, 'kept-folder', 'team', 'notes.txt')), await readFile(join(f.files, 'team', 'notes.txt')))
})
