import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { mkdir, writeFile, readdir, stat, access } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

const url = process.env.FB_VERIFY_URL ?? 'http://filebrowser.internal:3000'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence'
await mkdir(output, { recursive: true })
const results = []
let cookie = ''
let staleAttemptId = ''
let observedTemporaryBytes = 0
let cleanupBusyResponses = 0
const started = Date.now()
const check = (name, detail = '') => { results.push({ name, status: 'PASS', detail }); console.log('PASS ' + name + (detail ? ': ' + detail : '')) }
async function api(path, body, method, target = url, token = cookie) {
  return fetch(target + '/api' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'X-Filebrowser-Request': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), cookie: token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) })
}
async function body(response, status = 200) {
  const data = await response.json()
  assert.equal(response.status, status, JSON.stringify(data))
  return data
}
function chunk(index, length) {
  const value = Buffer.alloc(length)
  const pattern = createHash('sha256').update('filebrowser-verification-chunk-' + index).digest()
  for (let offset = 0; offset < length; offset += pattern.length) pattern.copy(value, offset, 0, Math.min(pattern.length, length - offset))
  if (length >= 8) value.writeBigUInt64LE(BigInt(index), 0)
  return value
}
async function sendPart(session, attempt, part, bytes, target = url, token = cookie) {
  const response = await fetch(`${target}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${part.index}`, {
    method: 'PUT', headers: { cookie: token, 'X-Filebrowser-Request': '1', 'Content-Type': 'application/octet-stream' }, body: bytes,
    signal: AbortSignal.timeout(60_000),
  })
  assert.equal(response.status, 204, await response.text())
}
async function commitChunk(session, bytes, connections = 1, target = url, token = cookie) {
  let response = await api(`/uploads/${session.id}/chunks/${session.nextChunk}/start`, { connections }, undefined, target, token)
  const deadline = Date.now() + 3000
  while (response.status === 409 && (await response.clone().json()).code === 'UPLOAD_BUSY' && Date.now() < deadline) {
    cleanupBusyResponses++
    await delay(20)
    response = await api(`/uploads/${session.id}/chunks/${session.nextChunk}/start`, { connections }, undefined, target, token)
  }
  const attempt = await body(response)
  if (target === url && session.nextChunk === 1 && staleAttemptId) {
    const stale = await fetch(`${target}/api/uploads/${session.id}/attempts/${staleAttemptId}/parts/0`, { method: 'PUT', headers: { cookie: token, 'X-Filebrowser-Request': '1', 'Content-Type': 'application/octet-stream' }, body: bytes.subarray(0, 1) })
    assert.equal(stale.status, 409)
    check('expired token cannot affect a new current attempt')
  }
  await Promise.all(attempt.parts.map(part => sendPart(session, attempt, part, bytes.subarray(part.offset, part.offset + part.size), target, token)))
  if (target === url) {
    const temporary = await stat(join('/verify-files', '.filebrowser-uploads', session.id, 'chunk'))
    assert.equal(temporary.size, bytes.length)
    observedTemporaryBytes = Math.max(observedTemporaryBytes, temporary.size)
  }
  const index = session.nextChunk
  const next = await body(await api(`/uploads/${session.id}/chunks/${index}/commit`, { attemptId: attempt.id }, undefined, target, token))
  return { next, attempt, index }
}

try {
  const bootstrap = await body(await api('/bootstrap'))
  assert.equal(bootstrap.upload.chunkSize, 102400)
  check('production container advertises 100 KiB override', JSON.stringify(bootstrap.upload))
  if (bootstrap.needsSetup) {
    const setup = await api('/setup', { username: 'admin', password: 'container-verification-password', siteName: 'Filebrowser verification' })
    assert.equal(setup.status, 201); cookie = setup.headers.get('set-cookie').split(';')[0]
  } else {
    const login = await api('/auth/login', { username: 'admin', password: 'container-verification-password' })
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0]
  }
  check('authenticated production API')
  assert.equal((await api('/setup', { username: 'second', password: 'container-verification-password', siteName: 'No' })).status, 409)
  assert.equal((await api('/files', undefined, undefined, url, '')).status, 401)
  check('one-time setup and anonymous access denial')
  for (const name of ['../escape', '.filebrowser-secret', 'bad/name', 'bad\\name']) {
    assert.equal((await api('/uploads', { name, directory: '/', size: 0, chunkSize: 102400, lastModified: 0, hashes: [] })).status, 400)
  }
  assert.equal((await api('/uploads', { name: 'invalid.bin', directory: '/', size: 5, chunkSize: 102400, lastModified: 0, hashes: [] })).status, 400)
  check('unsafe names and malformed manifests rejected')

  const chunkSize = bootstrap.upload.chunkSize
  const size = 1024 ** 3
  const count = Math.ceil(size / chunkSize)
  const hashes = []
  const sourceHash = createHash('sha256')
  for (let index = 0; index < count; index++) {
    const bytes = chunk(index, Math.min(chunkSize, size - index * chunkSize))
    hashes.push(createHash('sha256').update(bytes).digest('hex')); sourceHash.update(bytes)
  }
  const expectedHash = sourceHash.digest('hex')
  const manifest = { name: 'one-gib-verified.bin', directory: '/', size, lastModified: 0, chunkSize, hashes }
  let session = await body(await api('/uploads', manifest), 201)
  const duplicate = await body(await api('/uploads', manifest), 201)
  assert.equal(duplicate.id, session.id)
  check('1 GiB manifest initializes idempotently', `${count} unique chunks; last chunk ${size - (count - 1) * chunkSize} bytes`)
  assert.equal((await api(`/uploads/${session.id}/chunks/1/start`, { connections: 1 })).status, 409)
  check('next chunk cannot start before the current durable commit')

  let attempt = await body(await api(`/uploads/${session.id}/chunks/0/start`, { connections: 4 }))
  const first = chunk(0, chunkSize)
  const wrong = Buffer.from(first); wrong[100] ^= 255
  await Promise.all(attempt.parts.map(part => sendPart(session, attempt, part, wrong.subarray(part.offset, part.offset + part.size))))
  assert.equal((await api(`/uploads/${session.id}/chunks/0/commit`, { attemptId: attempt.id })).status, 422)
  session = await body(await api(`/uploads/${session.id}`))
  assert.equal(session.committedBytes, 0)
  assert.equal((await stat(join('/verify-files', '.filebrowser-uploads', session.id, 'target'))).size, 0)
  assert.deepEqual(await readdir(join('/verify-files', '.filebrowser-uploads', session.id)), ['target'])
  check('checksum mismatch rolls back and deletes the entire chunk')

  attempt = await body(await api(`/uploads/${session.id}/chunks/0/start`, { connections: 2 }))
  const oldId = attempt.id
  staleAttemptId = oldId
  const short = await fetch(`${url}/api/uploads/${session.id}/attempts/${oldId}/parts/0`, { method: 'PUT', headers: { cookie, 'X-Filebrowser-Request': '1', 'Content-Type': 'application/octet-stream' }, body: first.subarray(0, 10) })
  assert.equal(short.status, 400)
  assert.deepEqual(await readdir(join('/verify-files', '.filebrowser-uploads', session.id)), ['target'])
  check('short part poisons and discards the attempt')

  attempt = await body(await api(`/uploads/${session.id}/chunks/0/start`, { connections: 2 }))
  let connectionClosed
  const closed = new Promise(resolve => { connectionClosed = resolve })
  const stalled = httpRequest(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/0`, { method: 'PUT', headers: { cookie, 'X-Filebrowser-Request': '1', 'Content-Type': 'application/octet-stream', 'Content-Length': attempt.parts[0].size } }, response => response.resume())
  stalled.on('error', () => connectionClosed()); stalled.on('close', () => connectionClosed())
  stalled.write(first.subarray(0, 512))
  await delay(100)
  const invalidSibling = await fetch(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/1`, { method: 'PUT', headers: { cookie, 'X-Filebrowser-Request': '1', 'Content-Type': 'application/octet-stream' }, body: first.subarray(0, 1) })
  assert.equal(invalidSibling.status, 400)
  await Promise.race([closed, delay(3000).then(() => { throw new Error('Failed part did not close its stalled sibling') })])
  for (let retry = 0; retry < 100 && (await readdir(join('/verify-files', '.filebrowser-uploads', session.id))).includes('chunk'); retry++) await delay(20)
  assert.deepEqual(await readdir(join('/verify-files', '.filebrowser-uploads', session.id)), ['target'])
  check('one failed part closes a stalled sibling and permits whole-chunk retry')

  const transferStart = performance.now()
  let restarted = false
  let maxChunkBytes = 0
  let duplicateCommits = 0
  let fourConnections = 0
  while (session.nextChunk < count) {
    const index = session.nextChunk
    const bytes = chunk(index, Math.min(chunkSize, size - index * chunkSize))
    const connections = index < 24 || index % 127 === 0 ? 4 : 1
    if (connections === 4) fourConnections++
    const result = await commitChunk(session, bytes, connections)
    const prior = session.committedBytes
    session = result.next
    assert.equal(session.nextChunk, index + 1)
    assert.equal(session.committedBytes, prior + bytes.length)
    if (index % 251 === 0) {
      const replay = await body(await api(`/uploads/${session.id}/chunks/${index}/commit`, { attemptId: result.attempt.id }))
      assert.equal(replay.committedBytes, session.committedBytes); duplicateCommits++
      const files = await readdir(join('/verify-files', '.filebrowser-uploads', session.id))
      assert.deepEqual(files, ['target'])
      assert.equal((await stat(join('/verify-files', '.filebrowser-uploads', session.id, 'target'))).size, session.committedBytes)
    }
    maxChunkBytes = Math.max(maxChunkBytes, bytes.length)
    if (!restarted && index === 4095) {
      const checkpoint = { id: session.id, nextChunk: session.nextChunk, committedBytes: session.committedBytes, requestTime: new Date().toISOString() }
      await writeFile(join(output, 'restart-request.json'), JSON.stringify(checkpoint, null, 2))
      console.log('RESTART_CHECKPOINT ' + JSON.stringify(checkpoint))
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        try { await access(join(output, 'restart-done')); break } catch { await delay(200) }
      }
      await access(join(output, 'restart-done'))
      const after = await body(await api(`/uploads/${session.id}`))
      assert.equal(after.nextChunk, checkpoint.nextChunk); assert.equal(after.committedBytes, checkpoint.committedBytes)
      session = after; restarted = true
      check('production container SIGKILL/restart preserves acknowledged offset', `${checkpoint.committedBytes} bytes / ${checkpoint.nextChunk} chunks`)
    }
    if (index % 500 === 0) console.log(`PROGRESS ${session.nextChunk}/${count} committed=${session.committedBytes}`)
  }
  check('all 10486 chunks committed in strict order', `${duplicateCommits} replayed commits; ${fourConnections} chunks with 4 connections; max temporary chunk=${maxChunkBytes}`)
  const targetInode = (await stat(join('/verify-files', '.filebrowser-uploads', session.id, 'target'))).ino
  const completed = await body(await api(`/uploads/${session.id}/complete`, {}))
  assert.equal(completed.status, 'completed')
  assert.equal((await body(await api(`/uploads/${session.id}/complete`, {}))).status, 'completed')
  assert.equal((await stat('/verify-files/one-gib-verified.bin')).size, size)
  assert.equal((await stat('/verify-files/one-gib-verified.bin')).ino, targetInode)
  assert.deepEqual(await readdir('/verify-files/.filebrowser-uploads'), [])
  const actualHash = createHash('sha256')
  for await (const bytes of createReadStream('/verify-files/one-gib-verified.bin')) actualHash.update(bytes)
  assert.equal(actualHash.digest('hex'), expectedHash)
  const elapsedSeconds = (performance.now() - transferStart) / 1000
  check('completed 1 GiB file matches full SHA-256', expectedHash)
  check('staging cleanup and idempotent publication', `${elapsedSeconds.toFixed(1)} seconds including controlled restart`)
  check('publication retains the same inode without a final copy', String(targetInode))
  assert.equal((await api('/uploads', manifest)).status, 409)
  check('a completed destination cannot be overwritten')
  const range = await fetch(url + '/api/files/content?path=/one-gib-verified.bin', { headers: { cookie, Range: `bytes=${2048 * chunkSize}-${2048 * chunkSize + 63}` } })
  assert.equal(range.status, 206)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), chunk(2048, chunkSize).subarray(0, 64))
  check('large-file byte range returns the expected unique chunk bytes')
  await writeFile(join(output, 'large-upload-results.json'), JSON.stringify({ status: 'PASS', startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), size, chunkSize, chunks: count, expectedHash, elapsedSeconds, duplicateCommits, fourConnections, maxChunkBytes, observedTemporaryBytes, cleanupBusyResponses, results }, null, 2))
} catch (error) {
  await writeFile(join(output, 'large-upload-results.json'), JSON.stringify({ status: 'FAIL', error: error.stack, results }, null, 2))
  throw error
}
