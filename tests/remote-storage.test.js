import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { createServer as httpServer, request as httpRequest } from 'node:http'
import { createServer as tcpServer, createConnection } from 'node:net'
import { Client as FTP } from 'basic-ftp'
import { Client as SSH } from 'ssh2'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { S3Client, CreateBucketCommand, ListMultipartUploadsCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { createApp } from '../backend/app.ts'
import { FileRemoteStorage } from '../backend/storage/remote.ts'
import { S3Storage } from '../backend/storage/s3.ts'
import { HttpError } from '../backend/errors.ts'

const enabled = process.env.FB_TEST_REMOTES === 'true', chunkSize = 5 * 1024 * 1024
const s3 = { type: 's3', bucket: 'filebrowser-test', region: 'us-east-1', endpoint: 'http://minio:9000', prefix: '', accessKeyId: 'fixture-access', secretAccessKey: 'container-fixture-secret', sessionToken: '', forcePathStyle: true }
const connections = {
  s3, ftp: { type: 'ftp', host: 'remotes', port: 2121, username: 'fixture', password: 'container-fixture-password', root: '/ftp', tls: false },
  ftps: { type: 'ftp', host: 'remotes', port: 2122, username: 'fixture', password: 'container-fixture-password', root: '/ftps', tls: true },
  sftp: { type: 'sftp', host: 'remotes', port: 22, username: 'fixture', password: 'container-fixture-password', privateKey: '', passphrase: '', root: '/srv/remote/sftp', hostKey: process.env.FB_TEST_SFTP_HOST_KEY ?? '' },
}
async function bucket() {
  const client = new S3Client({ endpoint: s3.endpoint, region: s3.region, forcePathStyle: true, credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } })
  try { await client.send(new CreateBucketCommand({ Bucket: s3.bucket })) }
  catch (error) { if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)) throw error }
  return client
}
function config(type) { return { name: type.toUpperCase(), enabled: true, readOnly: false, connection: { ...connections[type], ...(type === 's3' ? { prefix: randomUUID() } : {}) } } }
for (const type of Object.keys(connections)) {
  test(`${type}: final authorization guards prevent mkdir, rename and deletion after remote checks`, { skip: !enabled }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'filebrowser-remote-access-'))
    const connection = config(type).connection
    if (type === 's3') { const client = await bucket(); client.destroy() }
    const storage = type === 's3' ? new S3Storage(connection, directory, false) : new FileRemoteStorage(connection, directory, false)
    const name = '/access-' + randomUUID(), target = name + '-moved', folder = name + '-directory'
    t.after(async () => { storage.close(); await rm(directory, { recursive: true, force: true }) })
    const denied = () => { throw new HttpError(403, 'Permission revoked') }
    await assert.rejects(storage.mkdir(folder, denied), error => error.statusCode === 403)
    await assert.rejects(storage.stat(folder), error => error.code === 'ENOENT')
    const id = randomUUID(), token = await storage.createStage(id, name)
    await storage.publish(id, name, token, 0); await storage.removeStage(id, undefined, undefined, false)
    try {
      await assert.rejects(storage.move(name, target, denied), error => error.statusCode === 403)
      assert.equal((await storage.stat(name)).kind, 'file')
      await assert.rejects(storage.stat(target), error => error.code === 'ENOENT')
      await assert.rejects(storage.remove(name, denied), error => error.statusCode === 403)
      assert.equal((await storage.stat(name)).kind, 'file')
    } finally { await storage.remove(name) }
  })
}
async function fixture(t, type, crashAt = '', override = {}) {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-remote-')), stateDirectory = join(root, 'state')
  let app, child, closed, address, cookie = '', output = ''
  const start = async fault => {
    if (fault !== undefined) {
      const entry = fileURLToPath(new URL('./fixtures/crash-server.js', import.meta.url))
      child = spawn(process.execPath, ['--import', 'tsx', entry], { env: { ...process.env, FB_STATE_DIR: stateDirectory, FB_UPLOAD_CHUNK_SIZE: String(chunkSize), FB_CRASH_AT: fault }, stdio: ['ignore', 'pipe', 'pipe'] })
      closed = once(child, 'close'); output = ''
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      for (let tries = 0; tries < 200 && !output.includes('READY ') && child.exitCode === null; tries++) await delay(50)
      address = /READY (http:\/\/\S+)/.exec(output)?.[1]; assert.ok(address, output)
    } else { app = await createApp({ stateDirectory, chunkSize }); address = await app.listen({ host: '127.0.0.1', port: 0 }) }
  }
  await start(crashAt || undefined)
  const request = (path, body, method = body === undefined ? 'GET' : 'POST') => fetch(address + '/api' + path, { method, headers: { cookie, 'x-filebrowser-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const targetConfig = config(type); Object.assign(targetConfig.connection, override)
  const setup = await request('/setup', { username: 'admin', password: 'remote-fixture-password', siteName: 'Remote fixture', target: targetConfig })
  assert.equal(setup.status, 201, await setup.clone().text()); cookie = setup.headers.get('set-cookie').split(';')[0]
  const targetId = (await (await request('/targets')).json())[0].id
  t.after(async () => { if (app) await app.close(); if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed } await rm(root, { recursive: true, force: true }) })
  return { request, targetId, targetConfig, stateDirectory, get address() { return address }, get cookie() { return cookie },
    async restart() { if (app) { await app.close(); app = undefined } if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed } child = undefined; await start() },
    async killed() { const [, signal] = await closed; assert.equal(signal, 'SIGKILL'); child = undefined },
  }
}
function manifest(f, name, bytes, directory = '/') {
  const hashes = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) hashes.push(createHash('sha256').update(bytes.subarray(offset, offset + chunkSize)).digest('hex'))
  return { targetId: f.targetId, name, directory, size: bytes.length, lastModified: 0, chunkSize, hashes }
}
async function init(f, name, bytes, directory = '/') { const response = await f.request('/uploads', manifest(f, name, bytes, directory)); assert.equal(response.status, 201, await response.clone().text()); return response.json() }
async function send(f, session, index, bytes, corrupt = false) {
  const response = await f.request(`/uploads/${session.id}/chunks/${index}/start`, { connections: 4 }); assert.equal(response.status, 200, await response.clone().text()); const attempt = await response.json()
  for (const part of attempt.parts) {
    const data = Buffer.from(bytes.subarray(index * chunkSize + part.offset, index * chunkSize + part.offset + part.size)); if (corrupt && part.index === 0) data[0] ^= 255
    const sent = await fetch(`${f.address}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${part.index}`, { method: 'PUT', headers: { cookie: f.cookie, 'x-filebrowser-request': '1', 'content-type': 'application/octet-stream' }, body: data })
    assert.equal(sent.status, 204, await sent.text())
  }
  return f.request(`/uploads/${session.id}/chunks/${index}/commit`, { attemptId: attempt.id })
}

for (const type of Object.keys(connections)) {
  test(`${type}: CRUD, strict chunk order, corruption rollback, resume, range reads, archives and bounded staging`, { skip: !enabled, timeout: 180_000 }, async t => {
    const client = await bucket(); t.after(() => client.destroy())
    const f = await fixture(t, type), fileApi = `/targets/${f.targetId}/files`, directory = '/' + randomUUID()
    const tested = await f.request('/admin/targets/' + f.targetId + '/test', {}); assert.equal(tested.status, 200, await tested.clone().text())
    assert.equal((await f.request(fileApi + '/directories', { directory: '/', name: directory.slice(1) })).status, 200)
    const bytes = Buffer.alloc(chunkSize * 2 + 193, 0x59); bytes[chunkSize] = 0x71; bytes[bytes.length - 1] = 0x36
    const session = await init(f, 'payload.bin', bytes, directory)
    assert.equal((await f.request(fileApi + '/directories', { directory: '/', name: directory.slice(1), existOk: true })).status, 200, 'folder uploads can reuse a remote directory with an active child transfer')
    assert.equal((await f.request(fileApi + '/directories', { directory, name: 'Nested', existOk: true })).status, 200)
    assert.equal((await f.request(fileApi + '/directories', { directory, name: 'Nested', existOk: true })).status, 200)
    assert.equal((await f.request(`/uploads/${session.id}/chunks/1/start`, { connections: 1 })).status, 409)
    const corrupt = await send(f, session, 0, bytes, true); assert.equal(corrupt.status, 422, await corrupt.clone().text())
    assert.equal((await (await f.request(`/uploads/${session.id}`)).json()).committedBytes, 0)
    let commit = await send(f, session, 0, bytes); assert.equal(commit.status, 200, await commit.clone().text())
    assert.equal((await commit.json()).committedBytes, chunkSize)
    const listing = await (await f.request(fileApi + '?path=' + directory)).json(), pending = listing.entries.find(entry => entry.name === 'payload.bin.uploading')
    assert.ok(pending); assert.equal(pending.uploading, true); assert.equal(pending.size, chunkSize)
    assert.equal((await f.request(fileApi + '/content?path=' + directory + '/payload.bin.uploading')).status, 409)
    const stages = await readdir(join(f.stateDirectory, 'targets', f.targetId)); assert.deepEqual(stages, [session.id]); assert.ok(!(await readdir(join(f.stateDirectory, 'targets', f.targetId, session.id))).includes('chunk'))
    await f.restart()
    for (const index of [1, 2]) { commit = await send(f, session, index, bytes); assert.equal(commit.status, 200, await commit.clone().text()) }
    const completed = await f.request(`/uploads/${session.id}/complete`, {}); assert.equal(completed.status, 200, await completed.clone().text()); assert.equal((await completed.json()).status, 'completed')
    const folderConflict = await f.request(fileApi + '/directories', { directory, name: 'payload.bin', existOk: true })
    assert.equal(folderConflict.status, 409); assert.equal((await folderConflict.json()).code, 'DESTINATION_EXISTS')
    assert.deepEqual(Buffer.from(await (await f.request(fileApi + '/content?path=' + directory + '/payload.bin')).arrayBuffer()), bytes)
    const ranged = await fetch(`${f.address}/api${fileApi}/content?path=${directory}/payload.bin`, { headers: { cookie: f.cookie, range: `bytes=${chunkSize - 2}-${chunkSize + 2}` } }); assert.equal(ranged.status, 206); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(chunkSize - 2, chunkSize + 3))
    const head = await fetch(`${f.address}/api${fileApi}/content?path=${directory}/payload.bin`, { method: 'HEAD', headers: { cookie: f.cookie } }); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0)
    const ticket = await (await f.request(fileApi + '/archive-tickets', { paths: [directory] })).json(), archive = await f.request(ticket.url.slice(4)); assert.equal(archive.status, 200); assert.ok((await archive.arrayBuffer()).byteLength > bytes.length)
    assert.equal((await f.request(fileApi, { path: directory + '/payload.bin', name: 'renamed.bin' }, 'PATCH')).status, 200)
    assert.equal((await f.request(fileApi + '?path=' + directory + '/renamed.bin', undefined, 'DELETE')).status, 200)
    const empty = await init(f, 'empty.txt', Buffer.alloc(0), directory); assert.equal((await f.request(`/uploads/${empty.id}/complete`, {})).status, 200)
    assert.equal((await f.request(fileApi + '?path=' + directory + '/empty.txt', undefined, 'DELETE')).status, 200)
    const unicodeName = '文件 #1.uploading', unicodeBytes = Buffer.from('Unicode path fixture')
    const unicode = await init(f, unicodeName, unicodeBytes, directory)
    assert.equal((await send(f, unicode, 0, unicodeBytes)).status, 200)
    assert.equal((await f.request(`/uploads/${unicode.id}/complete`, {})).status, 200)
    const unicodePath = encodeURIComponent(directory + '/' + unicodeName)
    assert.deepEqual(Buffer.from(await (await f.request(fileApi + '/content?path=' + unicodePath)).arrayBuffer()), unicodeBytes)
    assert.equal((await f.request(fileApi + '?path=' + unicodePath, undefined, 'DELETE')).status, 200)
    assert.equal((await f.request(fileApi + '?path=' + directory + '/Nested', undefined, 'DELETE')).status, 200)
    assert.equal((await f.request(fileApi + '?path=' + directory, undefined, 'DELETE')).status, 200)
    assert.deepEqual(await readdir(join(f.stateDirectory, 'targets', f.targetId)), [])
    if (type === 's3') assert.equal((await client.send(new ListMultipartUploadsCommand({ Bucket: s3.bucket, Prefix: f.targetConfig.connection.prefix }))).Uploads?.length ?? 0, 0)
  })
  for (const fault of ['append', 'publish', 'cancel']) {
    test(`${type}: SIGKILL after ${fault} recovers without duplicate bytes or deleting the published file`, { skip: !enabled, timeout: 90_000 }, async t => {
      const client = await bucket(); t.after(() => client.destroy())
      const f = await fixture(t, type, fault), name = randomUUID() + '.bin', bytes = Buffer.from('Crash-safe remote transfer'), session = await init(f, name, bytes)
      if (fault === 'append') { await assert.rejects(send(f, session, 0, bytes)); await f.killed(); await f.restart(); assert.equal((await (await f.request(`/uploads/${session.id}`)).json()).committedBytes, 0); const replay = await send(f, session, 0, bytes); assert.equal(replay.status, 200, await replay.clone().text()) }
      else { const committed = await send(f, session, 0, bytes); assert.equal(committed.status, 200, await committed.clone().text()); await assert.rejects(f.request(fault === 'cancel' ? `/uploads/${session.id}` : `/uploads/${session.id}/complete`, fault === 'cancel' ? undefined : {}, fault === 'cancel' ? 'DELETE' : 'POST')); await f.killed(); await f.restart() }
      if (fault === 'cancel') { const canceled = await f.request(`/uploads/${session.id}`, undefined, 'DELETE'); assert.equal(canceled.status, 200, await canceled.clone().text()); assert.equal((await canceled.json()).status, 'canceled'); return }
      const finalized = await f.request(`/uploads/${session.id}/complete`, {}); assert.equal(finalized.status, 200, await finalized.clone().text())
      assert.deepEqual(Buffer.from(await (await f.request(`/targets/${f.targetId}/files/content?path=/` + name)).arrayBuffer()), bytes)
      assert.equal((await f.request(`/uploads/${session.id}`, undefined, 'DELETE')).status, 409)
      assert.equal((await f.request(`/targets/${f.targetId}/files?path=/` + name, undefined, 'DELETE')).status, 200)
    })
  }
}

test('SFTP host identity is enforced and remote failures never leak credentials', { skip: !enabled, timeout: 30_000 }, async t => {
  const f = await fixture(t, 'sftp')
  const bad = await f.request('/admin/targets', { name: 'Wrong host key', enabled: true, readOnly: false, connection: { ...connections.sftp, root: '/srv/remote/host-key-check', hostKey: 'SHA256:' + 'A'.repeat(43) } })
  assert.equal(bad.status, 201); const id = (await bad.json()).id
  const response = await f.request('/admin/targets/' + id + '/test', {}); assert.equal(response.status, 503)
  const body = await response.text(); assert.ok(!body.includes(connections.sftp.password)); assert.match(body, /pinned host key/)
  const database = await readFile(join(f.stateDirectory, 'filebrowser.sqlite')); assert.ok(!database.includes(Buffer.from(connections.sftp.password)))
})

async function replaceRemote(f, bytes) {
  const session = (await (await f.request('/uploads')).json())[0]
  const stage = JSON.parse(await readFile(join(f.stateDirectory, 'targets', f.targetId, session.id, 'stage.json'), 'utf8'))
  const connection = f.targetConfig.connection
  if (connection.type === 'ftp') {
    const client = new FTP(10000)
    try { await client.access({ host: connection.host, port: connection.port, user: connection.username, password: connection.password, secure: connection.tls }); await client.uploadFrom(Readable.from([bytes]), stage.pending) }
    finally { client.close() }
  } else {
    const client = new SSH()
    client.connect({ host: connection.host, port: connection.port, username: connection.username, password: connection.password })
    await once(client, 'ready'); client.setNoDelay(true)
    try {
      const sftp = await new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)))
      const stream = sftp.createWriteStream(stage.pending, { flags: 'w' })
      stream.end(bytes); await once(stream, 'close')
    } finally { client.end() }
  }
}
for (const type of ['ftp', 'sftp']) for (const damage of ['truncated', 'corrupt']) {
  test(`${type}: ${damage} acknowledged remote data fails before advancing progress`, { skip: !enabled, timeout: 60000 }, async t => {
    const f = await fixture(t, type), bytes = Buffer.alloc(chunkSize + 7, 0x4f), session = await init(f, randomUUID() + '.bin', bytes)
    assert.equal((await send(f, session, 0, bytes)).status, 200)
    await replaceRemote(f, Buffer.alloc(damage === 'truncated' ? 13 : chunkSize, 0x3a))
    await f.restart()
    const next = await f.request(`/uploads/${session.id}/chunks/1/start`, { connections: 1 })
    assert.equal(next.status, 409, await next.clone().text()); assert.equal((await next.json()).code, 'DATA_LOSS')
    assert.equal((await (await f.request(`/uploads/${session.id}`)).json()).committedBytes, chunkSize)
    assert.equal((await f.request(`/uploads/${session.id}`, undefined, 'DELETE')).status, 200)
  })
}
for (const type of ['s3', 'sftp']) {
  test(`${type}: connection lost during remote write rolls back the entire chunk and resumes exactly`, { skip: !enabled, timeout: 60000 }, async t => {
    let armed = false, dropped = 0, reading = false
    const sockets = new Set()
    const proxy = type === 's3' ? httpServer((incoming, outgoing) => {
      const upstream = httpRequest({ hostname: 'minio', port: 9000, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
        outgoing.writeHead(response.statusCode, response.headers)
        let received = 0
        response.on('error', () => outgoing.destroy())
        response.on('data', bytes => { received += bytes.length; if (armed && reading && received > 65536) { armed = false; dropped++; response.destroy(); outgoing.destroy() } else outgoing.write(bytes) })
        response.on('end', () => outgoing.end())
      })
      upstream.on('error', () => outgoing.destroy())
      let count = 0
      incoming.on('data', bytes => {
        count += bytes.length
        if (armed && !reading && incoming.method === 'PUT' && incoming.url.includes('partNumber=') && count > 65536) {
          armed = false; dropped++; upstream.destroy(); incoming.destroy(); outgoing.destroy()
        } else upstream.write(bytes)
      })
      incoming.on('end', () => upstream.end()); incoming.on('error', () => upstream.destroy())
    }) : tcpServer(client => {
      const upstream = createConnection({ host: 'remotes', port: 22 })
      sockets.add(client); sockets.add(upstream)
      client.on('error', () => {}); upstream.on('error', () => client.destroy())
      let returned = 0
      upstream.on('data', bytes => { if (armed && reading) returned += bytes.length; if (armed && reading && returned > 65536) { armed = false; dropped++; client.destroy(); upstream.destroy() } else client.write(bytes) })
      let count = 0
      client.on('data', bytes => {
        if (armed && !reading) count += bytes.length
        if (armed && !reading && count > 65536) { armed = false; dropped++; client.destroy(); upstream.destroy() }
        else upstream.write(bytes)
      })
      client.once('close', () => { sockets.delete(client); upstream.destroy(); sockets.delete(upstream) })
    })
    proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)) })
    const port = proxy.address().port
    const f = await fixture(t, type, '', type === 's3' ? { endpoint: `http://127.0.0.1:${port}` } : { host: '127.0.0.1', port })
    const bytes = Buffer.alloc(chunkSize + 13, 0x3d), session = await init(f, randomUUID() + '.bin', bytes)
    console.log(type + ': remote stage initialized')
    armed = true
    const failed = await send(f, session, 0, bytes)
    console.log(type + ': remote connection failure returned')
    assert.equal(failed.status, 503, await failed.clone().text()); assert.equal(dropped, 1)
    assert.equal((await (await f.request(`/uploads/${session.id}`)).json()).committedBytes, 0)
    console.log(type + ': retrying from unchanged checkpoint')
    for (const index of [0, 1]) { const response = await send(f, session, index, bytes); assert.equal(response.status, 200, await response.clone().text()) }
    assert.equal((await f.request(`/uploads/${session.id}/complete`, {})).status, 200)
    const fileApi = `/targets/${f.targetId}/files`
    assert.deepEqual(Buffer.from(await (await f.request(fileApi + '/content?path=/' + session.name)).arrayBuffer()), bytes)
    armed = true; reading = true
    let interrupted
    try { interrupted = await fetch(f.address + '/api' + fileApi + '/content?path=/' + session.name, { headers: { cookie: f.cookie }, signal: AbortSignal.timeout(10000) }) }
    catch { /* A reset before headers is also a bounded failed download. */ }
    if (interrupted?.ok) await assert.rejects(interrupted.arrayBuffer())
    else if (interrupted) assert.equal(interrupted.status, 503, await interrupted.text())
    assert.equal(dropped, 2)
    assert.deepEqual(Buffer.from(await (await f.request(fileApi + '/content?path=/' + session.name)).arrayBuffer()), bytes)
    assert.equal((await f.request(fileApi + '?path=/' + session.name, undefined, 'DELETE')).status, 200)
  })
}

test('S3 directory prefixes with backslashes and controls never enter browser listings', { skip: !enabled, timeout: 30000 }, async t => {
  const client = await bucket(); t.after(() => client.destroy())
  const f = await fixture(t, 's3'), keys = ['bad\\folder/item.txt', 'control\u007f/item.txt', '.filebrowser-private/item.txt']
    .map(path => f.targetConfig.connection.prefix + '/' + path)
  try {
    for (const Key of keys) await client.send(new PutObjectCommand({ Bucket: s3.bucket, Key, Body: 'unsupported fixture', ContentLength: 19 }))
    const listing = await (await f.request(`/targets/${f.targetId}/files`)).json()
    assert.deepEqual(listing.entries, [])
  } finally { for (const Key of keys) await client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key })) }
})

test('S3 credentials can be repaired during a retained upload without losing its verified checkpoint', { skip: !enabled, timeout: 60000 }, async t => {
  const client = await bucket(); t.after(() => client.destroy())
  const f = await fixture(t, 's3'), bytes = Buffer.alloc(chunkSize + 7, 0x63), session = await init(f, randomUUID() + '.bin', bytes)
  assert.equal((await send(f, session, 0, bytes)).status, 200)
  const setting = await f.request('/admin/targets/' + f.targetId, { ...f.targetConfig, connection: { ...f.targetConfig.connection, forcePathStyle: false } }, 'PATCH')
  assert.equal(setting.status, 409)
  const broken = await f.request('/admin/targets/' + f.targetId, { ...f.targetConfig, connection: { ...f.targetConfig.connection, secretAccessKey: 'deliberately-invalid-fixture-secret' } }, 'PATCH')
  assert.equal(broken.status, 200, await broken.clone().text())
  const rejected = await f.request(`/uploads/${session.id}/chunks/1/start`, { connections: 1 })
  assert.equal(rejected.status, 403, await rejected.clone().text())
  assert.equal((await (await f.request('/uploads/' + session.id)).json()).committedBytes, chunkSize)
  const repaired = await f.request('/admin/targets/' + f.targetId, f.targetConfig, 'PATCH')
  assert.equal(repaired.status, 200, await repaired.clone().text())
  assert.equal((await send(f, session, 1, bytes)).status, 200)
  assert.equal((await f.request('/uploads/' + session.id + '/complete', {})).status, 200)
  const downloaded = await f.request(`/targets/${f.targetId}/files/content?path=/` + session.name)
  assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes)
})
