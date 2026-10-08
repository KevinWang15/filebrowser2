import { localTarget, firstTarget } from './fixtures/targets.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rename, stat, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from '../backend/app.ts'
import { READ_PERMISSIONS } from '../shared/types.ts'
import { controlSchema } from '../backend/shares/control.ts'
import { LocalStorage } from '../backend/storage/local.ts'
import { Store } from '../backend/store.ts'
import { DirectoryShares } from '../backend/shares/manager.ts'

async function fixture(t, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-shares-'))
  const options = { storageRoot: join(root, 'files'), stateDirectory: join(root, 'state'), smbEnabled: enabled }
  let app = await createApp({stateDirectory:options.stateDirectory,chunkSize:options.chunkSize,smbEnabled:options.smbEnabled})
  let address = await app.listen({ host: '127.0.0.1', port: 0 })
  let cookie = ''
  const directory = join(root, 'state', 'protocols')
  let stopped = false
  const agent = enabled ? (async () => {
    while (!stopped) {
      try {
        const control = controlSchema.parse(JSON.parse(await readFile(join(directory, 'desired.json'), 'utf8')))
        const temporary = join(directory, 'status-' + randomUUID())
        await writeFile(temporary, JSON.stringify({ version: 2, revision: control.revision, checkedAt: Date.now(), ready: control.expiresAt > Date.now(), error: '', active: control.shares.map(share => share.id), failed: [] }), { mode: 0o600 })
        await rename(temporary, join(directory, 'status.json'))
      } catch { /* The application can be restarting. */ }
      await delay(10)
    }
  })() : Promise.resolve()
  t.after(async () => { await app.close(); stopped = true; await agent; await rm(root, { recursive: true, force: true }) })
  const request = (path, method = 'GET', body, auth = cookie) => fetch(address + '/api' + path, { method,
    headers: { ...(auth ? { cookie: auth } : {}), 'x-filebrowser-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  const setup = await request('/setup', 'POST', { username: 'admin', password: 'protocol-test-password-123', siteName: 'Protocol tests', target: localTarget(options.storageRoot) })
  assert.equal(setup.status, 201)
  cookie = setup.headers.get('set-cookie').split(';')[0]
  const admin = await setup.json()
  const targetId = await firstTarget(request)
  return { root, directory, targetId, request, admin, get cookie() { return cookie }, get address() { return address },
    async restart() { await app.close(); app = await createApp({stateDirectory:options.stateDirectory,chunkSize:options.chunkSize,smbEnabled:options.smbEnabled}); address = await app.listen({ host: '127.0.0.1', port: 0 }) },
    async create(name = 'Documents', path = '/', ownerId = admin.id) {
      const response = await request('/admin/shares', 'POST', { targetId, name, path, ownerId })
      assert.equal(response.status, 201, await response.clone().text())
      return response.json()
    },
  }
}

test('SMB sharing is opt-in; creating shares is restricted to administrators and audited', async t => {
  const f = await fixture(t, false)
  const status = await (await f.request('/shares')).json()
  assert.equal(status.configured, false)
  assert.deepEqual(status.shares, [])
  assert.equal((await f.request('/admin/shares', 'POST', { targetId: f.targetId, name: 'Docs', path: '/', ownerId: f.admin.id })).status, 409)
  assert.equal((await f.request('/shares', 'GET', undefined, '')).status, 401)
  assert.equal((await f.request('/admin/shares', 'POST', { targetId: f.targetId, name: 'Docs', path: '/', ownerId: f.admin.id }, '')).status, 401)
})

test('a delayed SMB heartbeat cannot renew a revoked grant after its filesystem probe finishes', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const created = await f.request('/admin/users', 'POST', { username: 'lease-member', password: 'lease-member-password', role: 'user', grants: [{ targetId: f.targetId, scope: '/', permissions: READ_PERMISSIONS }] })
  assert.equal(created.status, 201)
  const member = await created.json(), issued = await f.create('LeaseDocuments', '/', member.id)
  const identity = LocalStorage.prototype.directoryIdentity, setGrants = Store.prototype.setGrants, write = DirectoryShares.prototype.writeControl
  let enter, release, changed, used = false, revoked = false, staleWrites = 0
  const entered = new Promise(resolve => { enter = resolve }), waiting = new Promise(resolve => { release = resolve }), committed = new Promise(resolve => { changed = resolve })
  LocalStorage.prototype.directoryIdentity = async function (path) {
    if (!used && path === '/') { used = true; enter(); await waiting }
    return identity.call(this, path)
  }
  Store.prototype.setGrants = function (id, grants) {
    const result = setGrants.call(this, id, grants)
    if (id === member.id) { revoked = true; changed() }
    return result
  }
  DirectoryShares.prototype.writeControl = async function (control, ...args) {
    const applied = await write.call(this, control, ...args)
    if (applied !== false && revoked && control.shares.some(share => share.id === issued.share.id)) staleWrites++
    return applied
  }
  const restore = () => { release(); LocalStorage.prototype.directoryIdentity = identity; Store.prototype.setGrants = setGrants; DirectoryShares.prototype.writeControl = write }
  t.after(restore)
  await entered
  const disabled = f.request('/admin/users/' + member.id, 'PATCH', { username: member.username, role: 'user', disabled: true, grants: [] })
  await committed; release()
  assert.equal((await disabled).status, 200)
  assert.equal(staleWrites, 0)
  const policy = JSON.parse(await readFile(join(f.directory, 'desired.json'), 'utf8'))
  assert.ok(!policy.shares.some(share => share.id === issued.share.id))
  restore()
})

test('invalid protocol configuration releases locks and valid public hostnames are reported', async t => {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-share-config-'))
  const options = { storageRoot: join(root, 'files'), stateDirectory: join(root, 'state') }
  let app
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }) })
  await assert.rejects(createApp({stateDirectory:options.stateDirectory, smbPublicHost: 'smb://bad.example/share' }), /hostname or IP address/)
  app = await createApp({stateDirectory:options.stateDirectory, smbPublicHost: 'files.example.com' })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const setup = await fetch(address + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Filebrowser-Request': '1' }, body: JSON.stringify({ username: 'admin', password: 'protocol-hostname-test-password', siteName: 'Host fixture', target: localTarget(options.storageRoot) }) })
  const cookie = setup.headers.get('set-cookie').split(';')[0]
  assert.equal((await (await fetch(address + '/api/shares', { headers: { cookie } })).json()).host, 'files.example.com')
})

test('share credentials are separate, private, durable and never returned by listing APIs', async t => {
  const f = await fixture(t)
  const created = await f.create()
  assert.equal(created.share.status, 'active')
  assert.equal(created.share.readOnly, true)
  assert.match(created.password, /^[A-Za-z0-9_-]{32}$/)
  const policy = controlSchema.parse(JSON.parse(await readFile(join(f.directory, 'desired.json'), 'utf8')))
  assert.match(policy.shares[0].ntHash, /^[A-F0-9]{32}$/)
  assert.ok(!JSON.stringify(policy).includes(created.password))
  assert.equal((await stat(join(f.directory, 'desired.json'))).mode & 0o077, 0)
  const additional = await f.create('Additional')
  assert.equal(additional.username, created.username)
  assert.equal(additional.password, null)
  const publicList = await (await f.request('/shares')).text()
  assert.ok(!publicList.includes(created.password) && !publicList.includes(policy.shares[0].ntHash))
  const duplicate = await f.request('/admin/shares', 'POST', { targetId: f.targetId, name: 'documents', path: '/', ownerId: f.admin.id })
  assert.equal(duplicate.status, 409)
  assert.match((await duplicate.json()).message, /share name/)
  await f.restart()
  const restored = await (await f.request('/shares')).json()
  assert.equal(restored.shares[0].id, created.share.id)
  const rotated = await (await f.request('/admin/shares/' + created.share.id + '/credentials', 'POST')).json()
  assert.notEqual(rotated.password, created.password)
  assert.equal(rotated.username, created.username)
  assert.notEqual(JSON.parse(await readFile(join(f.directory, 'desired.json'), 'utf8')).shares[0].ntHash, policy.shares[0].ntHash)
  assert.ok(!Buffer.from(await readFile(join(f.root, 'state', 'filebrowser.sqlite'))).includes(Buffer.from(created.password)))
  const actions = (await (await f.request('/admin/audit')).json()).map(entry => entry.action)
  assert.ok(actions.includes('share.created') && actions.includes('share.credentials_rotated'))
})

test('owner scopes and permissions govern exports, and changing them revokes the policy', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'files', 'team'))
  await mkdir(join(f.root, 'files', 'other'))
  const memberBody = { username: 'member', password: 'protocol-member-password', role: 'user', grants: [{ targetId: f.targetId, scope: '/team', permissions: READ_PERMISSIONS }], disabled: false }
  const member = await (await f.request('/admin/users', 'POST', memberBody)).json()
  assert.equal((await f.request('/admin/shares', 'POST', { targetId: f.targetId, name: 'WrongScope', path: '/other', ownerId: member.id })).status, 403)
  const created = await f.create('Team', '/team', member.id)
  const login = await f.request('/auth/login', 'POST', { username: 'member', password: memberBody.password })
  const memberCookie = login.headers.get('set-cookie').split(';')[0]
  const visible = await (await f.request('/shares', 'GET', undefined, memberCookie)).json()
  assert.equal(visible.shares.length, 1)
  assert.equal(visible.shares[0].path, '/')
  for (const [path, method, body] of [
    ['/admin/shares', 'POST', { targetId: f.targetId, name: 'Denied', path: '/team', ownerId: member.id }],
    ['/admin/shares/' + created.share.id, 'PATCH', { enabled: false }],
    ['/admin/shares/' + created.share.id + '/credentials', 'POST', undefined],
    ['/admin/shares/' + created.share.id, 'DELETE', undefined],
  ]) assert.equal((await f.request(path, method, body, memberCookie)).status, 403)
  assert.equal((await f.request('/admin/users/' + member.id, 'PATCH', { ...memberBody, grants:[{targetId:f.targetId,scope:'/team',permissions:{...READ_PERMISSIONS,download:false}}], password: undefined })).status, 200)
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'desired.json'), 'utf8')).shares, [])
  const blocked = (await (await f.request('/shares')).json()).shares[0]
  assert.equal(blocked.status, 'blocked')
  await f.request('/admin/users/' + member.id, 'PATCH', { ...memberBody, grants:[{targetId:f.targetId,scope:'/other',permissions:READ_PERMISSIONS}], password: undefined })
  const relogin = await f.request('/auth/login', 'POST', { username: 'member', password: memberBody.password })
  const hidden = (await (await f.request('/shares', 'GET', undefined, relogin.headers.get('set-cookie').split(';')[0])).json()).shares[0]
  assert.equal(hidden.path, '')
})

test('control publication failures preserve committed responses and recover without losing credentials', async t => {
  const f = await fixture(t)
  const owner = await (await f.request('/admin/users', 'POST', { username: 'control-owner', password: 'control-owner-password', role: 'user', grants: [{ targetId: f.targetId, scope: '/', permissions: READ_PERMISSIONS }], disabled: false })).json()
  const detached = f.directory + '-detached'
  await rename(f.directory, detached)
  try {
    const created = await f.create('Unavailable', '/', owner.id)
    assert.match(created.password, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(created.share.status, 'unavailable')
    assert.equal((await (await f.request('/shares')).json()).available, false)
    const rotated = await (await f.request('/admin/shares/' + created.share.id + '/credentials', 'POST')).json()
    assert.match(rotated.password, /^[A-Za-z0-9_-]{32}$/)
    assert.notEqual(rotated.password, created.password)
    assert.equal(rotated.share.status, 'unavailable')
    assert.equal((await f.request('/auth/password', 'POST', { currentPassword: 'protocol-test-password-123', newPassword: 'control-new-browser-password' })).status, 200)
    const login = await f.request('/auth/login', 'POST', { username: 'admin', password: 'control-new-browser-password' })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    assert.equal((await f.request('/admin/shares/' + created.share.id, 'DELETE', undefined, cookie)).status, 503)
    assert.equal((await (await f.request('/shares', 'GET', undefined, cookie)).json()).shares[0].enabled, false)
    await rename(detached, f.directory)
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await (await f.request('/shares', 'GET', undefined, cookie)).json()).available) break
      await delay(100)
    }
    assert.equal((await (await f.request('/shares', 'GET', undefined, cookie)).json()).available, true)
    assert.equal((await f.request('/admin/shares/' + created.share.id, 'DELETE', undefined, cookie)).status, 204)
  } finally {
    await rename(detached, f.directory).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
})

test('shutdown releases application locks when the control directory cannot be written', async t => {
  const f = await fixture(t)
  await f.create()
  const detached = f.directory + '-detached'
  await rename(f.directory, detached)
  try { await f.restart() }
  finally { await rm(detached, { recursive: true, force: true }) }
  assert.equal((await f.request('/bootstrap')).status, 200)
})

test('shared roots cannot be renamed or deleted; removal and password reset revoke grants', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'files', 'folder'))
  const created = await f.create('Folder', '/folder')
  assert.equal((await f.request(`/targets/${f.targetId}/files`, 'PATCH', { path: '/folder', name: 'moved' })).status, 409)
  assert.equal((await f.request(`/targets/${f.targetId}/files?path=/folder`, 'DELETE')).status, 409)
  const disabled = await f.request('/admin/shares/' + created.share.id, 'PATCH', { enabled: false })
  assert.equal((await disabled.json()).status, 'disabled')
  assert.equal(JSON.parse(await readFile(join(f.directory, 'desired.json'), 'utf8')).shares.length, 0)
  await f.request('/admin/shares/' + created.share.id, 'PATCH', { enabled: true })
  assert.equal(JSON.parse(await readFile(join(f.directory, 'desired.json'), 'utf8')).shares.length, 1)
  assert.equal((await f.request('/admin/shares/' + created.share.id, 'DELETE')).status, 204)
  assert.equal((await f.request(`/targets/${f.targetId}/files`, 'PATCH', { path: '/folder', name: 'moved' })).status, 200)
  const other = await f.create('Other')
  const changed = await f.request('/auth/password', 'POST', { currentPassword: 'protocol-test-password-123', newPassword: 'protocol-new-password-123' })
  assert.equal(changed.status, 200)
  assert.equal(JSON.parse(await readFile(join(f.directory, 'desired.json'), 'utf8')).shares.length, 0)
  const login = await f.request('/auth/login', 'POST', { username: 'admin', password: 'protocol-new-password-123' })
  const list = await (await f.request('/shares', 'GET', undefined, login.headers.get('set-cookie').split(';')[0])).json()
  assert.equal(list.shares.find(share => share.id === other.share.id).enabled, false)
  const adminCookie = login.headers.get('set-cookie').split(';')[0]
  const reenabled = await f.request('/admin/shares/' + other.share.id, 'PATCH', { enabled: true }, adminCookie)
  assert.equal((await reenabled.json()).status, 'blocked')
  assert.equal(JSON.parse(await readFile(join(f.directory, 'desired.json'), 'utf8')).shares.length, 0)
  const reset = await f.request('/admin/shares/' + other.share.id + '/credentials', 'POST', undefined, adminCookie)
  assert.equal((await reset.json()).share.status, 'active')
})

test('protocol configuration rejects unsafe names, paths, symlinks, files and writable flags', async t => {
  const f = await fixture(t)
  await mkdir(join(f.root, 'files', 'percent%U'))
  await writeFile(join(f.root, 'files', 'regular.txt'), 'bytes')
  await symlink(f.root, join(f.root, 'files', 'escape'))
  for (const body of [
    { name: 'global' }, { name: 'Homes' }, { name: 'Printers' }, { name: 'a\nb' }, { name: 'bad/name' },
    { path: '/..' }, { path: '/.filebrowser-uploads' }, { path: '/percent%U' }, { path: '/escape' }, { path: '/regular.txt' },
    { protocol: 'unknown' }, { readOnly: false },
  ]) {
    const response = await f.request('/admin/shares', 'POST', { targetId: f.targetId, name: 'Safe', path: '/', ownerId: f.admin.id, ...body })
    assert.ok([400, 403].includes(response.status), await response.text())
  }
  const extraAdmin = await (await f.request('/admin/users', 'POST', { username: 'another', password: 'protocol-another-password', role: 'admin', grants: [], disabled: false })).json()
  const created = await f.create('Admin', '/', extraAdmin.id)
  await f.request('/admin/users/' + extraAdmin.id, 'PATCH', { username: 'another', role: 'admin', grants: [], disabled: true })
  assert.equal((await (await f.request('/shares')).json()).shares.find(share => share.id === created.share.id).status, 'blocked')
  assert.equal(JSON.parse(await readFile(join(f.directory, 'desired.json'), 'utf8')).shares.length, 0)
})
