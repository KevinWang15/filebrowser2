import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, lstat, readFile, readdir, readlink, appendFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const base = process.env.FB_DEPLOY_BASE ?? '/root/filebrowser2'
const nonce = randomBytes(6).toString('hex')
const state = join(base, '.filebrowser-smoke-' + nonce)
const rootFolder = join(base, 'deployment-smoke-' + nonce)
const diskFolder = '/mnt/sda3/filebrowser2-smoke-' + nonce
const url = 'http://127.0.0.1:17288'
const node = join(base, 'runtime/bin/node')
const entry = join(base, 'app/dist/server/server.js')
const results = []
const checks = []
let server
let closed
let output = ''
let cookie = ''
const check = name => { checks.push({ name, status: 'PASS' }); console.log('PASS ' + name) }
async function start() {
  output = ''
  server = spawn(node, ['--enable-source-maps', entry], {
    cwd: join(base, 'app'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '17288', FB_STORAGE_ROOT: '/', FB_STATE_DIR: state, FB_LOG_LEVEL: 'warn', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  closed = once(server, 'close')
  const record = bytes => { output = (output + bytes).slice(-10000) }
  server.stdout.on('data', record)
  server.stderr.on('data', record)
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error(output)
    try { if ((await fetch(url + '/health')).ok) return } catch { /* Wait for the loopback listener. */ }
    await delay(100)
  }
  throw new Error('Server startup timed out: ' + output)
}
async function stop(signal = 'SIGTERM') {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill(signal)
    await closed
  }
}
const request = (path, data, method = data === undefined ? 'GET' : 'POST') => fetch(url + '/api' + path, {
  method, headers: { cookie, 'x-filebrowser-request': '1', ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
  body: data === undefined ? undefined : JSON.stringify(data),
})
const sha = data => createHash('sha256').update(data).digest('hex')

try {
  assert.equal(process.getuid(), 0)
  assert.notEqual((await lstat('/')).dev, (await lstat('/mnt/sda3')).dev)
  await mkdir(rootFolder)
  await mkdir(diskFolder)
  await start()
  const bootstrap = await (await request('/bootstrap')).json()
  assert.equal(bootstrap.needsSetup, true)
  assert.equal(bootstrap.upload.chunkSize, 100 * 1024 * 1024)
  assert.equal((await request('/files')).status, 401)
  const html = await (await fetch(url + '/')).text()
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1])
  assert.ok(assets.length >= 2)
  for (const path of assets) assert.equal((await fetch(url + path)).status, 200)
  check('private Node 24 serves production assets and setup, while anonymous file access is denied')

  const setup = await request('/setup', { username: 'smoke-admin', password: randomBytes(24).toString('hex'), siteName: 'Disposable deployment test' })
  assert.equal(setup.status, 201)
  cookie = setup.headers.get('set-cookie').split(';')[0]
  const user = await setup.json()
  assert.equal(user.role, 'admin')
  assert.equal(user.scope, '/')
  assert.ok(Object.values(user.permissions).every(Boolean))
  for (const path of ['/', '/etc', '/root', '/home', '/mnt/sda3']) {
    const listing = await request('/files?path=' + encodeURIComponent(path))
    assert.equal(listing.status, 200)
    assert.ok(Array.isArray((await listing.json()).entries))
  }
  assert.equal((await request('/files/content?path=' + encodeURIComponent(state + '/filebrowser.sqlite'))).status, 400)
  check('root administrator can browse the host filesystem while private account state stays inaccessible')

  const chunkSize = bootstrap.upload.chunkSize
  const bytes = Buffer.alloc(chunkSize + 1024 * 1024 + 17)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + Math.floor(i / (1024 * 1024))) % 251
  const hashes = [sha(bytes.subarray(0, chunkSize)), sha(bytes.subarray(chunkSize))]
  async function initialize(directory, name) {
    const response = await request('/uploads', { name, directory, size: bytes.length, lastModified: 0, chunkSize, hashes })
    assert.equal(response.status, 201, await response.clone().text())
    return response.json()
  }
  async function uploadChunk(session, index) {
    const response = await request(`/uploads/${session.id}/chunks/${index}/start`, { connections: 4 })
    assert.equal(response.status, 200)
    const attempt = await response.json()
    const parts = await Promise.all(attempt.parts.map(part => fetch(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${part.index}`, {
      method: 'PUT', headers: { cookie, 'x-filebrowser-request': '1', 'content-type': 'application/octet-stream' },
      body: bytes.subarray(index * chunkSize + part.offset, index * chunkSize + part.offset + part.size),
    })))
    for (const part of parts) assert.equal(part.status, 204)
    const commit = await request(`/uploads/${session.id}/chunks/${index}/commit`, { attemptId: attempt.id })
    assert.equal(commit.status, 200)
    return commit.json()
  }
  for (const directory of [rootFolder, diskFolder]) {
    const session = await initialize(directory, 'verified.bin')
    const pending = join(directory, 'verified.bin.uploading')
    const identity = await lstat(pending)
    const registry = join('/.filebrowser-uploads', session.id)
    const registryStat = await lstat(registry)
    const physical = registryStat.isSymbolicLink() ? await readlink(registry) : registry
    assert.equal((await lstat(physical)).dev, identity.dev)
    assert.equal(registryStat.isSymbolicLink(), directory === diskFolder)
    assert.equal((await request('/files/content?path=' + encodeURIComponent(pending))).status, 409)
    assert.equal((await request(`/uploads/${session.id}/chunks/1/start`, { connections: 1 })).status, 409)
    await uploadChunk(session, 0)
    const previousPid = server.pid
    await stop('SIGKILL')
    await appendFile(join(physical, 'target.uploading'), Buffer.from('uncommitted crash tail'))
    await start()
    const saved = await (await request('/uploads/' + session.id)).json()
    assert.equal(saved.nextChunk, 1)
    assert.equal(saved.committedBytes, chunkSize)
    assert.equal((await lstat(pending)).size, chunkSize)
    assert.equal((await lstat(pending)).ino, identity.ino)
    await uploadChunk(session, 1)
    assert.equal((await request(`/uploads/${session.id}/complete`, {})).status, 200)
    const final = join(directory, 'verified.bin')
    const actual = await readFile(final)
    assert.equal(sha(actual), sha(bytes))
    const finalIdentity = await lstat(final)
    assert.equal(finalIdentity.ino, identity.ino)
    assert.equal(finalIdentity.nlink, 1)
    await assert.rejects(lstat(pending), { code: 'ENOENT' })
    await assert.rejects(lstat(registry), { code: 'ENOENT' })
    const range = await fetch(url + '/api/files/content?path=' + encodeURIComponent(final), { headers: { cookie, Range: 'bytes=100-1123' } })
    assert.equal(range.status, 206)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(100, 1124))
    assert.equal((await request('/files', { path: final, name: 'renamed.bin' }, 'PATCH')).status, 200)
    assert.equal((await request('/files?path=' + encodeURIComponent(join(directory, 'renamed.bin')), undefined, 'DELETE')).status, 200)
    results.push({ directory, device: identity.dev, inode: identity.ino, bytes: bytes.length, chunkSize, sha256: sha(bytes), stagingOnTargetFilesystem: true, pidBeforeKill: previousPid, pidAfterRestart: server.pid, status: 'PASS' })
    check('101 MiB upload on ' + (directory === diskFolder ? 'the separate disk' : 'the root disk') + ' survives SIGKILL, truncates an uncommitted tail, preserves its inode, and supports range/rename/delete')
  }
  const canceled = await initialize(diskFolder, 'canceled.bin')
  await uploadChunk(canceled, 0)
  assert.equal((await request('/uploads/' + canceled.id, undefined, 'DELETE')).status, 200)
  await assert.rejects(lstat(join(diskFolder, 'canceled.bin.uploading')), { code: 'ENOENT' })
  await assert.rejects(lstat(join('/.filebrowser-uploads', canceled.id)), { code: 'ENOENT' })
  assert.deepEqual(await readdir('/.filebrowser-uploads'), [])
  check('cancellation removes the secondary-disk payload and central registry without publishing a partial file')
  await writeFile(join(base, 'deployment-verification.json'), JSON.stringify({ status: 'PASS', node: process.version, uid: process.getuid(), checks, uploads: results, needsSetupBeforeTest: true, disposableState: state, productionStateUntouched: true }, null, 2) + '\n')
} catch (error) {
  await writeFile(join(base, 'deployment-verification.json'), JSON.stringify({ status: 'FAIL', error: error.stack, checks, uploads: results, serverOutput: output }, null, 2) + '\n')
  throw error
} finally {
  await stop()
  // Only the unique directories created by this invocation are removed.
  for (const path of [rootFolder, diskFolder, state]) await rm(path, { recursive: true, force: true })
}
