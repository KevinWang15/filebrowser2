import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from '../backend/app.ts'
import { FULL_PERMISSIONS, READ_PERMISSIONS } from '../shared/types.ts'
import { localTarget, firstTarget } from './fixtures/targets.js'

async function fixture(t, target = true) {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-targets-')), stateDirectory = join(root, 'state')
  let app = await createApp({ stateDirectory, chunkSize: 65536 }), address = await app.listen({ host: '127.0.0.1', port: 0 }), cookie = ''
  const request = (path, method = 'GET', body) => fetch(address + '/api' + path, { method, headers: { cookie, 'x-filebrowser-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const before = await (await request('/bootstrap')).json()
  assert.deepEqual(before.targets, [])
  const setup = await request('/setup', 'POST', { username: 'admin', password: 'target-fixture-password', siteName: 'Targets', target: target ? localTarget(join(root, 'a')) : null })
  assert.equal(setup.status, 201, await setup.clone().text()); cookie = setup.headers.get('set-cookie').split(';')[0]
  const admin = await setup.json()
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  return { root, stateDirectory, admin, request, get cookie() { return cookie }, set cookie(value) { cookie = value }, get address() { return address },
    async restart() { await app.close(); app = await createApp({ stateDirectory, chunkSize: 65536 }); address = await app.listen({ host: '127.0.0.1', port: 0 }) } }
}
const manifest = (targetId, name, bytes) => ({ targetId, name, directory: '/', size: bytes.length, lastModified: 0, chunkSize: 65536, hashes: bytes.length ? [createHash('sha256').update(bytes).digest('hex')] : [] })
async function upload(f, targetId, name, data) {
  const initialized = await f.request('/uploads', 'POST', manifest(targetId, name, data))
  assert.equal(initialized.status, 201, await initialized.clone().text())
  const session = await initialized.json()
  if (data.length) {
    const attempt = await (await f.request(`/uploads/${session.id}/chunks/0/start`, 'POST', { connections: 4 })).json()
    for (const part of attempt.parts) {
      const sent = await fetch(`${f.address}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${part.index}`, { method: 'PUT', headers: { cookie: f.cookie, 'x-filebrowser-request': '1', 'content-type': 'application/octet-stream' }, body: data.subarray(part.offset, part.offset + part.size) })
      assert.equal(sent.status, 204)
    }
    const committed = await f.request(`/uploads/${session.id}/chunks/0/commit`, 'POST', { attemptId: attempt.id })
    assert.equal(committed.status, 200, await committed.clone().text())
  }
  const completed = await f.request(`/uploads/${session.id}/complete`, 'POST', {})
  assert.equal(completed.status, 200, await completed.clone().text())
  return session
}

test('setup can finish without targets; uploads require a target identity', async t => {
  const f = await fixture(t, false)
  assert.deepEqual((await (await f.request('/bootstrap')).json()).targets, [])
  const body = manifest('00000000-0000-4000-8000-000000000000', 'x', Buffer.alloc(0)); delete body.targetId
  assert.equal((await f.request('/uploads', 'POST', body)).status, 400)
  assert.equal((await f.request('/admin/targets', 'POST', localTarget(join(f.root, 'added')))).status, 201)
  assert.equal((await (await f.request('/targets')).json()).length, 1)
})

test('identical names, active reservations, archives and grants are isolated by target', async t => {
  const f = await fixture(t), a = await firstTarget(path => f.request(path))
  const response = await f.request('/admin/targets', 'POST', { ...localTarget(join(f.root, 'b')), name: 'Other' })
  assert.equal(response.status, 201); const b = (await response.json()).id
  await upload(f, a, 'same.txt', Buffer.from('from A')); await upload(f, b, 'same.txt', Buffer.from('from B'))
  for (const [id, expected] of [[a, 'from A'], [b, 'from B']]) assert.equal(await (await f.request(`/targets/${id}/files/content?path=/same.txt`)).text(), expected)
  const tickets = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const response = await f.request(`/targets/${index % 2 ? b : a}/files/archive-tickets`, 'POST', { paths: ['/same.txt'] })
    assert.equal(response.status, 200); return response.json()
  }))
  assert.equal((await f.request(`/targets/${b}/files/archive-tickets`, 'POST', { paths: ['/same.txt'] })).status, 429)
  assert.equal((await f.request(tickets[0].url.slice(4).replace(a, b))).status, 404)
  for (const ticket of tickets) {
    assert.equal((await f.request(ticket.url.slice(4), 'HEAD')).status, 200)
    const response = await f.request(ticket.url.slice(4)); assert.equal(response.status, 200); await response.arrayBuffer()
  }
  const pendingA = await f.request('/uploads', 'POST', manifest(a, 'pending.txt', Buffer.from('a')))
  const pendingB = await f.request('/uploads', 'POST', manifest(b, 'pending.txt', Buffer.from('b')))
  assert.equal(pendingA.status, 201); assert.equal(pendingB.status, 201)
  const account = await f.request('/admin/users', 'POST', { username: 'member', password: 'member-target-password', role: 'user', grants: [{ targetId: a, scope: '/', permissions: READ_PERMISSIONS }] })
  assert.equal(account.status, 201); const member = await account.json(), adminCookie = f.cookie
  const login = await f.request('/auth/login', 'POST', { username: 'member', password: 'member-target-password' }); f.cookie = login.headers.get('set-cookie').split(';')[0]
  assert.deepEqual((await (await f.request('/targets')).json()).map(target => target.id), [a])
  assert.equal((await f.request(`/targets/${b}/files`)).status, 403)
  assert.equal((await f.request('/uploads', 'POST', manifest(b, 'blocked.txt', Buffer.alloc(0)))).status, 403)
  const ticket = await (await f.request(`/targets/${a}/files/archive-tickets`, 'POST', { paths: ['/same.txt'] })).json()
  assert.equal((await f.request(ticket.url.slice(4).replace(a, b))).status, 403)
  f.cookie = adminCookie
  const changed = await f.request('/admin/users/' + member.id, 'PATCH', { username: 'member', role: 'user', disabled: false, grants: [{ targetId: b, scope: '/', permissions: FULL_PERMISSIONS }] })
  assert.equal(changed.status, 200)
  const relogin = await f.request('/auth/login', 'POST', { username: 'member', password: 'member-target-password' }); f.cookie = relogin.headers.get('set-cookie').split(';')[0]
  assert.equal((await f.request(ticket.url.slice(4))).status, 403)
  assert.deepEqual((await (await f.request('/targets')).json()).map(target => target.id), [b])
})

test('target disabling and read-only policy apply to saved uploads; immutable locations retain recovery identity', async t => {
  const f = await fixture(t), id = await firstTarget(path => f.request(path))
  const session = await (await f.request('/uploads', 'POST', manifest(id, 'paused.txt', Buffer.from('content')))).json()
  const created = await f.request('/admin/users', 'POST', { username: 'offline-member', password: 'offline-member-password', role: 'user', grants: [{ targetId: id, scope: '/', permissions: READ_PERMISSIONS }], disabled: false })
  assert.equal(created.status, 201); const member = await created.json()
  const config = { ...localTarget(join(f.root, 'a')), enabled: false }
  const disabled = await f.request('/admin/targets/' + id, 'PATCH', config)
  assert.equal(disabled.status, 200, await disabled.clone().text())
  const revoked = await f.request('/admin/users/' + member.id, 'PATCH', { username: member.username, role: 'user', grants: member.grants, disabled: true })
  assert.equal(revoked.status, 200, await revoked.clone().text())
  const changedScope = await f.request('/admin/users/' + member.id, 'PATCH', { username: member.username, role: 'user', grants: [{ ...member.grants[0], scope: '/new-scope' }], disabled: true })
  assert.equal(changedScope.status, 403)
  assert.equal((await f.request(`/uploads/${session.id}/chunks/0/start`, 'POST', { connections: 1 })).status, 403)
  assert.equal((await f.request('/admin/targets/' + id, 'DELETE')).status, 409)
  assert.equal((await f.request('/admin/targets/' + id, 'PATCH', { ...config, enabled: true, readOnly: true })).status, 200)
  assert.equal((await f.request(`/uploads/${session.id}/chunks/0/start`, 'POST', { connections: 1 })).status, 403)
  assert.equal((await f.request('/admin/targets/' + id, 'PATCH', { ...localTarget(join(f.root, 'different')) })).status, 400)
  assert.equal((await f.request('/admin/targets/' + id, 'PATCH', localTarget(join(f.root, 'a')))).status, 200)
  await f.restart()
  assert.equal((await (await f.request(`/uploads/${session.id}`)).json()).status, 'uploading')
  assert.equal((await f.request(`/uploads/${session.id}`, 'DELETE')).status, 200)
})

test('failed local write-access checks preserve settings and browsing; successful transitions retain their lock', async t => {
  const f = await fixture(t, false), root = join(f.root, 'readonly')
  await mkdir(root); await writeFile(join(root, 'readable.txt'), 'Still readable')
  const config = { ...localTarget(root), readOnly: true }
  const created = await f.request('/admin/targets', 'POST', config)
  assert.equal(created.status, 201); const id = (await created.json()).id
  const content = `/targets/${id}/files/content?path=/readable.txt`
  assert.equal(await (await f.request(content)).text(), 'Still readable')
  const blocker = new DatabaseSync(join(root, '.filebrowser-lock'))
  blocker.exec('BEGIN EXCLUSIVE')
  try {
    const rejected = await f.request('/admin/targets/' + id, 'PATCH', { ...config, name: 'Should not be saved', readOnly: false })
    assert.equal(rejected.status, 409)
    assert.equal((await rejected.json()).code, 'STORAGE_BUSY')
    let saved = (await (await f.request('/admin/targets')).json())[0]
    assert.equal(saved.name, config.name); assert.equal(saved.readOnly, true); assert.equal(saved.enabled, true)
    assert.equal(await (await f.request(content)).text(), 'Still readable')
    await f.restart()
    assert.equal((await f.request('/bootstrap')).status, 200)
    assert.equal(await (await f.request(content)).text(), 'Still readable')
    assert.equal((await f.request('/admin/targets/' + id, 'PATCH', { ...config, enabled: false, readOnly: false })).status, 200)
    assert.equal((await f.request('/admin/targets/' + id, 'PATCH', { ...config, readOnly: false })).status, 409)
    saved = (await (await f.request('/admin/targets')).json())[0]
    assert.equal(saved.enabled, false)
  } finally { blocker.close() }
  const writable = await f.request('/admin/targets/' + id, 'PATCH', { ...config, readOnly: false })
  assert.equal(writable.status, 200, await writable.clone().text())
  assert.equal((await writable.json()).readOnly, false)
  await upload(f, id, 'after-transition.txt', Buffer.from('Write access verified'))
  assert.equal(await (await f.request(`/targets/${id}/files/content?path=/after-transition.txt`)).text(), 'Write access verified')
  await f.restart()
  assert.equal((await f.request(`/targets/${id}/files`)).status, 200)
})

test('connection secrets are redacted, encrypted on disk, kept on edit, and never included in audit', async t => {
  const f = await fixture(t, false), secret = 'unique-fixture-secret-never-in-database'
  const config = { name: 'Object archive', enabled: true, readOnly: false, connection: { type: 's3', bucket: 'fixture', region: 'us-east-1', endpoint: 'http://127.0.0.1:1', prefix: '', accessKeyId: 'fixture-key', secretAccessKey: secret, sessionToken: '', forcePathStyle: true } }
  const response = await f.request('/admin/targets', 'POST', config); assert.equal(response.status, 201)
  const target = await response.json(); assert.equal(target.connection.secretAccessKey, ''); assert.ok(target.secrets.includes('secretAccessKey'))
  const changed = await f.request('/admin/targets/' + target.id, 'PATCH', { name: 'Renamed', enabled: true, readOnly: false, connection: target.connection })
  assert.equal(changed.status, 200); assert.ok((await changed.json()).secrets.includes('secretAccessKey'))
  for (const file of ['filebrowser.sqlite', 'filebrowser.sqlite-wal']) { const bytes = await readFile(join(f.stateDirectory, file)); assert.ok(!bytes.includes(Buffer.from(secret))) }
  assert.ok(!(await (await f.request('/admin/audit')).text()).includes(secret))
  assert.equal((await f.request('/admin/targets/' + target.id, 'DELETE')).status, 204)
})

test('unsupported or incomplete state is rejected without changing its schema or retaining a lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-schema-')); t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'filebrowser.sqlite')
  const db = new DatabaseSync(path); db.exec('CREATE TABLE unrelated(value TEXT)'); db.close()
  for (const version of [0, 999]) {
    const fixture = new DatabaseSync(path); fixture.exec('PRAGMA user_version = ' + version); fixture.close()
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(createApp({ stateDirectory: root }), /unsupported schema/)
    const inspected = new DatabaseSync(path)
    try { assert.deepEqual(inspected.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['unrelated']) }
    finally { inspected.close() }
  }
  await rm(path)
  const app = await createApp({ stateDirectory: root }); await app.close()
  const damaged = new DatabaseSync(path); damaged.exec('DROP TABLE sessions'); damaged.close()
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(createApp({ stateDirectory: root }), /no such table: sessions/)
  const inspected = new DatabaseSync(path)
  try { assert.equal(inspected.prepare("SELECT name FROM sqlite_schema WHERE name='sessions'").get(), undefined) }
  finally { inspected.close() }
})

test('a failed local setup remains retryable and does not create an administrator or target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-setup-target-')), stateDirectory = join(root, 'state')
  const app = await createApp({ stateDirectory }), address = await app.listen({ host: '127.0.0.1', port: 0 })
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  const invalid = join(root, 'ordinary-file'); const { writeFile } = await import('node:fs/promises'); await writeFile(invalid, 'fixture')
  const setup = target => fetch(address + '/api/setup', { method: 'POST', headers: { 'x-filebrowser-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'setup-retry-password', siteName: 'Retryable setup', target }) })
  assert.equal((await setup(localTarget(invalid))).status, 409)
  const bootstrap = await (await fetch(address + '/api/bootstrap')).json()
  assert.equal(bootstrap.needsSetup, true); assert.deepEqual(bootstrap.targets, [])
  const successful = await setup(localTarget(join(root, 'files')))
  assert.equal(successful.status, 201, await successful.clone().text())
  assert.equal((await successful.json()).role, 'admin')
})

test('remote roots, bucket names, and endpoints reject traversal, private namespaces and command controls', async t => {
  const f = await fixture(t, false)
  const base = { name: 'Invalid', enabled: true, readOnly: false }
  for (const root of ['/root/../escape', '/root/.filebrowser-secret', '/root\\escape', '/root\r\nDELE other']) {
    assert.equal((await f.request('/admin/targets', 'POST', { ...base, connection: { type: 'ftp', host: 'remote.invalid', port: 21, username: 'fixture', password: 'fixture', root, tls: true } })).status, 400)
  }
  const s3 = { type: 's3', bucket: 'bucket', region: 'us-east-1', endpoint: '', prefix: '', accessKeyId: 'fixture', secretAccessKey: 'fixture' }
  for (const change of [{ endpoint: 'not a URL' }, { endpoint: 'ftp://remote.invalid' }, { prefix: '../private' }, { prefix: '.filebrowser-private' }, { bucket: 'bad/bucket' }]) {
    assert.equal((await f.request('/admin/targets', 'POST', { ...base, connection: { ...s3, ...change } })).status, 400)
  }
})
