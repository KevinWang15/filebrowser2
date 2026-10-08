import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createApp } from '../backend/app.ts'
import { LocalStorage } from '../backend/storage/local.ts'
import { FULL_PERMISSIONS, READ_PERMISSIONS } from '../shared/types.ts'
import { localTarget } from './fixtures/targets.js'

const password = 'security-fixture-password'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-security-'))
  const stateDirectory = join(root, '.filebrowser-state'), files = join(root, 'files')
  const app = await createApp({ stateDirectory, chunkSize: 65536 })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  let adminCookie = ''
  const request = (url, method = 'GET', payload, cookie = adminCookie) => app.inject({
    url: '/api' + url, method, headers: { cookie, 'x-filebrowser-request': '1' }, ...(payload === undefined ? {} : { payload }),
  })
  const setup = await request('/setup', 'POST', { username: 'admin', password, siteName: 'Security fixture', target: localTarget(files) })
  assert.equal(setup.statusCode, 201, setup.body)
  adminCookie = setup.headers['set-cookie'].split(';')[0]
  const targetId = (await request('/targets')).json()[0].id
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  await mkdir(join(files, 'team')); await mkdir(join(files, 'other'))
  async function login(username, loginPassword = password) {
    const response = await request('/auth/login', 'POST', { username, password: loginPassword })
    assert.equal(response.statusCode, 200, response.body)
    return response.headers['set-cookie'].split(';')[0]
  }
  async function member(grants = [{ targetId, scope: '/team', permissions: READ_PERMISSIONS }], role = 'user', username = 'member') {
    const response = await request('/admin/users', 'POST', { username, password, role, grants })
    assert.equal(response.statusCode, 201, response.body)
    return { ...response.json(), cookie: await login(username) }
  }
  return { root, files, stateDirectory, app, address, targetId, request, login, member, adminCookie, admin: setup.json() }
}

function gate(t, method, path) {
  const previous = LocalStorage.prototype[method]
  let release, enter, used = false
  const waiting = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { enter = resolve })
  LocalStorage.prototype[method] = async function (input, ...args) {
    if (!used && input === path) { used = true; enter(); await waiting }
    return previous.call(this, input, ...args)
  }
  const restore = () => { release(); LocalStorage.prototype[method] = previous }
  t.after(restore)
  return { entered, release, restore }
}

test('the routed API URL enforces CSRF and authentication even when static segments are encoded', async t => {
  const f = await fixture(t)
  for (const url of ['/%61pi/auth/login', '/api/auth/%6cogin', '/a%70i/auth/login']) {
    const blocked = await f.app.inject({ url, method: 'POST', payload: { username: 'admin', password } })
    assert.equal(blocked.statusCode, 403, url)
    assert.equal(blocked.headers['set-cookie'], undefined)
    const foreign = await f.app.inject({ url, method: 'POST', headers: { 'x-filebrowser-request': '1', origin: 'https://attacker.example' }, payload: { username: 'admin', password } })
    assert.equal(foreign.statusCode, 403, url)
  }
  for (const url of ['/%61pi/admin/users', `/api/targets/${f.targetId}/%66iles`]) {
    const anonymous = await f.app.inject({ url })
    assert.equal(anonymous.statusCode, 401, url)
    assert.equal(anonymous.headers['cache-control'], 'no-store')
  }
  const valid = await f.app.inject({ url: '/%61pi/auth/login', method: 'POST', headers: { 'x-filebrowser-request': '1' }, payload: { username: 'admin', password } })
  assert.equal(valid.statusCode, 200)
})

test('local target roots reject overlapping targets and allow application-state directories', async t => {
  const f = await fixture(t)
  for (const root of [join(f.files, 'team'), f.root, f.files + '/', join(f.files, '.filebrowser-uploads')]) {
    const response = await f.request('/admin/targets', 'POST', { ...localTarget(root), name: 'Unsafe root' })
    assert.ok([400, 409].includes(response.statusCode), `${root}: ${response.body}`)
  }
  assert.equal((await f.request('/admin/targets', 'POST', { ...localTarget(join(f.root, 'files-other')), name: 'Sibling' })).statusCode, 201)
  assert.equal((await f.request('/admin/targets', 'POST', { ...localTarget(f.stateDirectory), name: 'Application state', readOnly:true })).statusCode, 201)
  assert.equal((await f.request('/admin/targets', 'POST', { ...localTarget(join(f.root, '.FILEBROWSER-data')), name: 'Dot directory' })).statusCode, 201)
})

test('remote targets reject equal or nested namespaces while allowing sibling prefixes and roots', async t => {
  const f = await fixture(t)
  const configurations = [
    { type: 's3', bucket: 'fixture', region: 'us-east-1', endpoint: 'https://storage.example', prefix: 'team', accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' },
    { type: 'ftp', host: 'storage.example', port: 21, username: 'fixture', password, root: '/team', tls: true },
    { type: 'sftp', host: 'storage.example', port: 22, username: 'fixture', password, root: '/team', hostKey: 'SHA256:' + 'a'.repeat(43) },
  ]
  for (const connection of configurations) {
    const field = connection.type === 's3' ? 'prefix' : 'root', parent = connection.type === 's3' ? '' : '/'
    const create = (name, value) => f.request('/admin/targets', 'POST', { name, connection: { ...connection, [field]: value } })
    assert.equal((await create(connection.type, connection[field])).statusCode, 201)
    for (const value of [connection[field], connection[field] + '/nested', parent]) assert.equal((await create('Overlap', value)).statusCode, 409)
    assert.equal((await create(connection.type + ' sibling', connection[field] + '-other')).statusCode, 201)
  }
})

test('a concurrent grant edit preserves a newly changed password instead of restoring the old hash', async t => {
  const f = await fixture(t), member = await f.member()
  const blocked = gate(t, 'stat', '/other')
  const edit = f.request('/admin/users/' + member.id, 'PATCH', { username: member.username, role: 'user', disabled: false, grants: [{ targetId: f.targetId, scope: '/other', permissions: READ_PERMISSIONS }] })
  await blocked.entered
  const changed = await f.request('/auth/password', 'POST', { currentPassword: password, newPassword: 'new-security-fixture-password' }, member.cookie)
  assert.equal(changed.statusCode, 200, changed.body)
  blocked.release()
  assert.equal((await edit).statusCode, 200)
  blocked.restore()
  assert.equal((await f.request('/auth/login', 'POST', { username: member.username, password })).statusCode, 401)
  assert.equal((await f.request('/auth/login', 'POST', { username: member.username, password: 'new-security-fixture-password' })).statusCode, 200)
})

test('concurrent password changes cannot both succeed using a revoked session and the old password', async t => {
  const f = await fixture(t), member = await f.member()
  const replacements = ['first-replacement-password', 'second-replacement-password']
  const responses = await Promise.all(replacements.map(newPassword => f.request('/auth/password', 'POST', { currentPassword: password, newPassword }, member.cookie)))
  assert.equal(responses.filter(response => response.statusCode === 200).length, 1)
  assert.ok(responses.every(response => [200, 401, 409].includes(response.statusCode)))
  const winner = replacements[responses.findIndex(response => response.statusCode === 200)]
  assert.equal((await f.request('/auth/login', 'POST', { username: member.username, password: winner })).statusCode, 200)
})

test('a demoted administrator cannot finish a user creation that was waiting on storage', async t => {
  const f = await fixture(t), second = await f.member([], 'admin', 'second-admin')
  const blocked = gate(t, 'stat', '/other')
  const pending = f.request('/admin/users', 'POST', { username: 'unauthorized-account', password, role: 'user', grants: [{ targetId: f.targetId, scope: '/other', permissions: FULL_PERMISSIONS }] })
  await blocked.entered
  assert.equal((await f.request('/admin/users/' + f.admin.id, 'PATCH', { username: 'admin', role: 'user', disabled: false, grants: [] }, second.cookie)).statusCode, 200)
  blocked.release()
  assert.ok([401, 403].includes((await pending).statusCode))
  blocked.restore()
  assert.ok(!(await f.request('/admin/users', 'GET', undefined, second.cookie)).json().some(user => user.username === 'unauthorized-account'))
})

test('a revoked administrator cannot commit a target write-access transition and its temporary lock is released', async t => {
  const f = await fixture(t), second = await f.member([], 'admin', 'second-admin')
  const root = join(f.root, 'readonly')
  await mkdir(root)
  const config = { ...localTarget(root, true), name: 'Read-only fixture' }
  const created = await f.request('/admin/targets', 'POST', config)
  assert.equal(created.statusCode, 201, created.body)
  const targetId = created.json().id, previous = LocalStorage.prototype.init
  let release, enter
  const waiting = new Promise(resolve => { release = resolve }), entered = new Promise(resolve => { enter = resolve })
  const restore = () => { release(); LocalStorage.prototype.init = previous }
  t.after(restore)
  LocalStorage.prototype.init = async function () {
    if (this.root === root) { enter(); await waiting }
    return previous.call(this)
  }
  const pending = f.request('/admin/targets/' + targetId, 'PATCH', { ...config, readOnly: false })
  await entered
  assert.equal((await f.request('/admin/users/' + f.admin.id, 'PATCH', { username: 'admin', role: 'user', disabled: false, grants: [] }, second.cookie)).statusCode, 200)
  release()
  assert.equal((await pending).statusCode, 401)
  restore()
  const targets = (await f.request('/admin/targets', 'GET', undefined, second.cookie)).json()
  assert.equal(targets.find(target => target.id === targetId).readOnly, true)
  const permitted = await f.request('/admin/targets/' + targetId, 'PATCH', { ...config, readOnly: false }, second.cookie)
  assert.equal(permitted.statusCode, 200, permitted.body)
})

test('revoking access while a listing waits prevents the old scope from being returned', async t => {
  const f = await fixture(t), member = await f.member()
  await writeFile(join(f.files, 'team', 'confidential.txt'), 'scope-private-data')
  const blocked = gate(t, 'list', '/team')
  const pending = f.request(`/targets/${f.targetId}/files`, 'GET', undefined, member.cookie)
  await blocked.entered
  assert.equal((await f.request('/admin/users/' + member.id, 'PATCH', { username: member.username, role: 'user', disabled: false, grants: [] })).statusCode, 200)
  blocked.release()
  const response = await pending
  assert.ok([401, 403].includes(response.statusCode), response.body)
  assert.ok(!response.body.includes('confidential.txt'))
})

test('revoking access while a mutation waits prevents the filesystem write', async t => {
  const f = await fixture(t), member = await f.member([{ targetId: f.targetId, scope: '/team', permissions: FULL_PERMISSIONS }])
  const blocked = gate(t, 'mkdir', '/team/unauthorized')
  const pending = f.request(`/targets/${f.targetId}/files/directories`, 'POST', { directory: '/', name: 'unauthorized' }, member.cookie)
  await blocked.entered
  assert.equal((await f.request('/admin/users/' + member.id, 'PATCH', { username: member.username, role: 'user', disabled: true, grants: member.grants })).statusCode, 200)
  blocked.release()
  assert.ok([401, 403].includes((await pending).statusCode))
  await assert.rejects(access(join(f.files, 'team', 'unauthorized')), { code: 'ENOENT' })
})

test('revoking access during upload initialization prevents a pending file and session from being created', async t => {
  const f = await fixture(t), member = await f.member([{ targetId: f.targetId, scope: '/team', permissions: FULL_PERMISSIONS }])
  const blocked = gate(t, 'space', '/team')
  const pending = f.request('/uploads', 'POST', { targetId: f.targetId, name: 'unauthorized.bin', directory: '/', size: 0, lastModified: 0, chunkSize: 65536, hashes: [] }, member.cookie)
  await blocked.entered
  assert.equal((await f.request('/admin/users/' + member.id, 'PATCH', { username: member.username, role: 'user', disabled: false, grants: [] })).statusCode, 200)
  blocked.release()
  assert.ok([401, 403].includes((await pending).statusCode))
  await assert.rejects(access(join(f.files, 'team', 'unauthorized.bin.uploading')), { code: 'ENOENT' })
  const cookie = await f.login(member.username)
  assert.deepEqual((await f.request('/uploads', 'GET', undefined, cookie)).json(), [])
})

for (const archive of [false, true]) {
  for (const revocation of ['permissions', 'logout', 'target', 'target removal', 'expiry']) {
    test(`${archive ? 'single-file archive' : 'file download'} is aborted during ${revocation} revocation, even with a stalled source`, { timeout: 15000 }, async t => {
      const f = await fixture(t), member = await f.member()
      await writeFile(join(f.files, 'team', 'secret.bin'), Buffer.alloc(2 * 1024 * 1024))
      const previous = LocalStorage.prototype.open, source = new PassThrough()
      const closed = new Promise(resolve => { source.once('close', resolve) })
      source.on('error', () => { /* Revocation intentionally aborts this source. */ })
      t.after(() => { LocalStorage.prototype.open = previous; source.destroy() })
      LocalStorage.prototype.open = async function (path, ...args) {
        if (path !== '/team/secret.bin') return previous.call(this, path, ...args)
        source.write(Buffer.alloc(65536, 0x61))
        return source
      }
      let path = `/api/targets/${f.targetId}/files/content?path=/secret.bin`
      if (archive) {
        const ticket = await f.request(`/targets/${f.targetId}/files/archive-tickets`, 'POST', { paths: ['/secret.bin'] }, member.cookie)
        assert.equal(ticket.statusCode, 200, ticket.body)
        path = ticket.json().url
      }
      if (revocation === 'expiry') f.app.auth.store.db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(Date.now() + 1000, member.id)
      const response = await fetch(f.address + path, { headers: { cookie: member.cookie } })
      assert.equal(response.status, 200)
      const reader = response.body.getReader()
      assert.ok((await reader.read()).value.length > 0)
      if (revocation === 'expiry') { /* The expiry timer must close the stalled source without another request. */ }
      else if (revocation === 'logout') assert.equal((await f.request('/auth/logout', 'POST', undefined, member.cookie)).statusCode, 204)
      else if (revocation === 'target') assert.equal((await f.request('/admin/targets/' + f.targetId, 'PATCH', { ...localTarget(f.files), enabled: false })).statusCode, 200)
      else if (revocation === 'target removal') assert.equal((await f.request('/admin/targets/' + f.targetId, 'DELETE')).statusCode, 204)
      else assert.equal((await f.request('/admin/users/' + member.id, 'PATCH', { username: member.username, role: 'user', disabled: false, grants: [] })).statusCode, 200)
      await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Revoked stream stayed open')), 2000); timer.unref() })])
      assert.equal(source.destroyed, true)
      let bytes = 0
      await assert.rejects(async () => { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length } })
      assert.ok(bytes < 2 * 1024 * 1024)
    })
  }
}

test('download authorization does not query SQLite for every streamed buffer', async t => {
  const f = await fixture(t)
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61)
  await writeFile(join(f.files, 'large.bin'), bytes)
  const db = f.app.auth.store.db, previous = db.prepare
  let queries = 0
  db.prepare = function (...args) { queries++; return previous.apply(this, args) }
  t.after(() => { db.prepare = previous })
  const response = await f.request(`/targets/${f.targetId}/files/content?path=/large.bin`)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.rawPayload, bytes)
  assert.ok(queries < 40, `A 2 MiB download prepared ${queries} statements`)
})
