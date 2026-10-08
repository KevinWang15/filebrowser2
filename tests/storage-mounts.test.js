import { localTarget, firstTarget } from './fixtures/targets.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, lstat, readlink, unlink, symlink, appendFile, statfs, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createApp } from '../backend/app.ts'
import { LocalStorage } from '../backend/storage/local.ts'

test('mounted filesystems retain sequential-upload durability', { skip: !process.env.FB_TEST_MOUNT_PATH }, async t => {
  const storageRoot = process.env.FB_TEST_STORAGE_ROOT
  const mount = process.env.FB_TEST_MOUNT_PATH
  assert.ok(storageRoot && mount)
  assert.notEqual((await lstat(storageRoot)).dev, (await lstat(mount)).dev, 'fixture must use two real filesystems')
  const directory = '/' + relative(storageRoot, mount)
  const stateDirectory = await mkdtemp(join(tmpdir(), 'filebrowser-mounted-state-'))
  const chunkSize = 65536
  const bytes = Buffer.alloc(chunkSize * 2 + 17)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + Math.floor(i / chunkSize)) % 251
  const hashes = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) hashes.push(createHash('sha256').update(bytes.subarray(offset, offset + chunkSize)).digest('hex'))
  let app
  let url
  let cookie = ''
  let targetId
  const options = { storageRoot, stateDirectory, chunkSize }
  async function restart(uploadFaults = {}) {
    if (app) await app.close()
    app = await createApp({stateDirectory:options.stateDirectory,chunkSize:options.chunkSize,uploadFaults})
    url = await app.listen({ host: '127.0.0.1', port: 0 })
  }
  const request = (path, data, method = data === undefined ? 'GET' : 'POST') => fetch(url + '/api' + path, {
    method, headers: { cookie, 'x-filebrowser-request': '1', ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  async function initialize(name) {
    const response = await request('/uploads', { targetId: targetId, name, directory, size: bytes.length, lastModified: 0, chunkSize, hashes })
    assert.equal(response.status, 201, await response.clone().text())
    return response.json()
  }
  async function chunk(session, index, corrupt = false) {
    const start = await request(`/uploads/${session.id}/chunks/${index}/start`, { connections: 4 })
    assert.equal(start.status, 200)
    const attempt = await start.json()
    for (const part of attempt.parts) {
      const data = Buffer.from(bytes.subarray(index * chunkSize + part.offset, index * chunkSize + part.offset + part.size))
      if (corrupt && part.index === 1) data[0] ^= 255
      const response = await fetch(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${part.index}`, {
        method: 'PUT', headers: { cookie, 'x-filebrowser-request': '1', 'content-type': 'application/octet-stream' }, body: data,
      })
      assert.equal(response.status, 204)
    }
    const commit = await request(`/uploads/${session.id}/chunks/${index}/commit`, { attemptId: attempt.id })
    assert.equal(commit.status, corrupt ? 422 : 200)
    return commit
  }
  async function allChunks(session) { for (let i = 0; i < hashes.length; i++) await chunk(session, i) }
  const registry = id => join(storageRoot, '.filebrowser-uploads', id)
  const diskFiles = []
  await restart()
  t.after(async () => {
    await app.close()
    for (const path of diskFiles) await rm(path, { force: true })
    await rm(stateDirectory, { recursive: true, force: true })
  })
  const setup = await request('/setup', { username: 'admin', password: 'mounted-filesystem-test-password', siteName: 'Mounted filesystem test',target:localTarget(storageRoot) })
  assert.equal(setup.status, 201)
  cookie = setup.headers.get('set-cookie').split(';')[0]
  targetId = await firstTarget(request)

  await t.test('four-part chunks, corruption rollback, missing alias, restart, publication and target capacity', async () => {
    const session = await initialize('mounted-resume.bin')
    const link = await readlink(registry(session.id))
    assert.equal((await lstat(registry(session.id))).isSymbolicLink(), true)
    assert.equal((await lstat(link)).dev, (await lstat(mount)).dev)
    const pending = join(mount, session.name + '.uploading')
    const inode = (await lstat(pending)).ino
    assert.equal((await request(`/targets/${targetId}/files?path=` + encodeURIComponent(directory))).status, 200)
    assert.equal((await request(`/targets/${targetId}/files/content?path=` + encodeURIComponent(directory + '/' + session.name + '.uploading'))).status, 409)
    assert.equal((await request(`/uploads/${session.id}/chunks/1/start`, { connections: 1 })).status, 409)
    await chunk(session, 0)
    await chunk(session, 1, true)
    assert.equal((await (await request('/uploads/' + session.id)).json()).committedBytes, chunkSize)
    await assert.rejects(lstat(join(link, 'chunk')), { code: 'ENOENT' })
    await appendFile(join(link, 'target.uploading'), Buffer.from('uncommitted tail'))
    await unlink(pending)
    await restart()
    assert.equal((await lstat(pending)).ino, inode)
    assert.equal((await lstat(pending)).size, chunkSize)
    for (let index = 1; index < hashes.length; index++) await chunk(session, index)
    assert.equal((await request(`/uploads/${session.id}/complete`, {})).status, 200)
    assert.equal((await request(`/uploads/${session.id}/complete`, {})).status, 200)
    const target = join(mount, session.name)
    diskFiles.push(target)
    assert.deepEqual(await readFile(target), bytes)
    assert.equal((await lstat(target)).ino, inode)
    assert.equal((await lstat(target)).nlink, 1)
    await assert.rejects(lstat(registry(session.id)), { code: 'ENOENT' })
    await assert.rejects(lstat(link), { code: 'ENOENT' })
    await assert.rejects(lstat(pending), { code: 'ENOENT' })
    const space = await new LocalStorage(storageRoot).space(directory)
    const filesystem = await statfs(mount)
    assert.equal(space.total, filesystem.blocks * filesystem.bsize)
  })

  await t.test('interrupted publication and cancellation finish on restart', async () => {
    await restart({ afterPublishLink: () => { throw new Error('Simulated interruption after publication link') } })
    const published = await initialize('mounted-publish.bin')
    await allChunks(published)
    assert.equal((await request(`/uploads/${published.id}/complete`, {})).status, 500)
    const target = join(mount, published.name)
    diskFiles.push(target)
    assert.equal((await lstat(target)).ino, (await lstat(target + '.uploading')).ino)
    await restart()
    assert.equal((await (await request('/uploads/' + published.id)).json()).status, 'completed')
    assert.deepEqual(await readFile(target), bytes)
    await assert.rejects(lstat(registry(published.id)), { code: 'ENOENT' })
    await restart({ afterCancelCleanup: () => { throw new Error('Simulated interruption after cancellation cleanup') } })
    const canceled = await initialize('mounted-cancel.bin')
    await chunk(canceled, 0)
    assert.equal((await request('/uploads/' + canceled.id, undefined, 'DELETE')).status, 500)
    await restart()
    assert.equal((await (await request('/uploads/' + canceled.id)).json()).status, 'canceled')
    await assert.rejects(lstat(join(mount, canceled.name + '.uploading')), { code: 'ENOENT' })
    await assert.rejects(lstat(registry(canceled.id)), { code: 'ENOENT' })
  })

  await t.test('an unavailable filesystem retains its registry and reservation', async () => {
    const session = await initialize('mounted-unavailable.bin')
    const original = await readlink(registry(session.id))
    const unavailable = original.replace(/\.filebrowser-uploads-([0-9]+)/, (_, device) => '.filebrowser-uploads-' + (BigInt(device) + 1n))
    await app.close()
    app = undefined
    await unlink(registry(session.id))
    await symlink(unavailable, registry(session.id))
    await restart()
    const saved = await (await request('/uploads/' + session.id)).json()
    assert.equal(saved.status, 'failed')
    assert.match(saved.error, /filesystem is unavailable/)
    assert.equal((await request('/uploads/' + session.id, undefined, 'DELETE')).status, 409)
    assert.equal(await readlink(registry(session.id)), unavailable)
    await unlink(registry(session.id))
    await symlink(original, registry(session.id))
    assert.equal((await request('/uploads/' + session.id, undefined, 'DELETE')).status, 200)
    await assert.rejects(lstat(original), { code: 'ENOENT' })
  })

  await t.test('abandoned aliases and interrupted stage creation are cleaned through the registry', async () => {
    const storage = new LocalStorage(storageRoot)
    const orphan = randomUUID()
    const inode = await storage.createStage(orphan, directory + '/mounted-orphan.bin')
    await storage.restoreStage(orphan, directory + '/mounted-orphan.bin', inode)
    const physical = await readlink(registry(orphan))
    const incomplete = randomUUID()
    await symlink(join(physical, '..', incomplete), registry(incomplete))
    await restart()
    await assert.rejects(lstat(physical), { code: 'ENOENT' })
    await assert.rejects(lstat(join(mount, 'mounted-orphan.bin.uploading')), { code: 'ENOENT' })
    assert.deepEqual(await readdir(join(storageRoot, '.filebrowser-uploads')), [])
  })
})
