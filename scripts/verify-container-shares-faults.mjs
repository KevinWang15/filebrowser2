import { verificationTargetId } from './verification-targets.mjs'
// Native client half of verify-container-shares-recovery.mjs. Secrets stay here.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
const url = process.env.FB_VERIFY_URL ?? 'http://app:3000'
const host = process.env.FB_VERIFY_SMB_HOST ?? 'smb'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence'
const control = join(output, 'recovery-control')
const temporary = await mkdtemp(join(tmpdir(), 'filebrowser-smb-recovery-'))
let targetId
const results = []
let cookie
async function api(path, body, method = body ? 'POST' : 'GET', expected = 200) {
  const response = await fetch(url + '/api' + path, { method,
    headers: { cookie, 'X-Filebrowser-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) })
  assert.equal(response.status, expected, await response.clone().text())
  return expected === 204 ? null : response.json()
}
async function signal(name) { await writeFile(join(control, name), '') }
async function wait(name) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try { await readFile(join(control, name)); return } catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(100)
  }
  throw new Error('Recovery driver did not acknowledge ' + name)
}
async function download(authentication, denied = false) {
  const destination = join(temporary, 'downloaded.txt')
  await rm(destination, { force: true })
  let result
  try {
    result = { code: 0, ...(await execute('smbclient', [`//${host}/Other`, '-A', authentication,
      '--use-kerberos=off', '--client-protection=encrypt', '-m', 'SMB3', '-t', '2', '-c', `get private.txt "${destination}"`], { timeout: 5_000 })) }
  } catch (error) { result = { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }
  if (denied) {
    assert.ok(result.code !== 0 || /NT_STATUS_(?!OK\b|SUCCESS\b)/.test(result.stdout + result.stderr))
    try { assert.equal((await readFile(destination)).length, 0) } catch (error) { if (error.code !== 'ENOENT') throw error }
  } else {
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.equal(await readFile(destination, 'utf8'), 'Another user’s folder.')
  }
}
async function restored(authentication) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await download(authentication); return } catch { await delay(200) }
  }
  throw new Error('Native SMB download did not recover')
}
function check(name) { results.push({ name, status: 'PASS' }); console.log('PASS ' + name) }
try {
  await mkdir(control, { recursive: true })
  const response = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'X-Filebrowser-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'protocol-container-admin-password' }) })
  assert.equal(response.status, 200)
  cookie = response.headers.get('set-cookie').split(';')[0]
  targetId = verificationTargetId(await api('/bootstrap'))
  const original = (await api('/shares')).shares.find(share => share.name === 'Other')
  assert.ok(original)
  const credentials = await api('/admin/shares/' + original.id + '/credentials', {})
  const authentication = join(temporary, 'auth')
  await writeFile(authentication, `username = ${credentials.username}\npassword = ${credentials.password}\n`, { mode: 0o600 })
  await restored(authentication)
  await signal('restart-smb-request')
  await wait('restart-smb-done')
  await restored(authentication)
  check('restarting the Samba companion restores the same share and password')
  await signal('kill-app-request')
  await wait('lease-expired')
  await download(authentication, true)
  await assert.rejects(fetch(url + '/health', { signal: AbortSignal.timeout(2_000) }))
  check('a killed application cannot leave native SMB access beyond its control lease')
  await signal('restart-app-request')
  await wait('restart-app-done')
  await restored(authentication)
  let current
  for (let attempt = 0; attempt < 60; attempt++) {
    current = (await api('/shares')).shares.find(share => share.id === original.id)
    if (current?.status === 'active') break
    await delay(100)
  }
  assert.equal(current?.username, credentials.username)
  assert.equal(current?.status, 'active')
  check('application restart preserves share definitions, credentials and exact file bytes')
  await signal('invalid-control-request')
  await wait('invalid-control-done')
  await download(authentication, true)
  await signal('restore-control-request')
  await wait('restore-control-done')
  await restored(authentication)
  check('malformed control files revoke access and a valid heartbeat restores the same credentials')
  await api(`/targets/${targetId}/files/directories`, { directory: '/', name: 'Removable' })
  const removable = await api('/admin/shares', { targetId, name: 'RevocationTarget', path: '/Removable', ownerId: original.ownerId }, 'POST', 201)
  await signal('stop-smb-request')
  await wait('stop-smb-done')
  await api('/admin/shares/' + removable.share.id, undefined, 'DELETE', 503)
  const retained = (await api('/shares')).shares.find(share => share.id === removable.share.id)
  assert.equal(retained?.enabled, false)
  await api(`/targets/${targetId}/files`, { path: '/Removable', name: 'Moved' }, 'PATCH', 409)
  await signal('start-smb-request')
  await wait('start-smb-done')
  await restored(authentication)
  await api('/admin/shares/' + removable.share.id, undefined, 'DELETE', 204)
  await api(`/targets/${targetId}/files`, { path: '/Removable', name: 'Moved' }, 'PATCH')
  assert.ok(!(await api('/shares')).shares.some(share => share.id === removable.share.id))
  check('offline removal retains a disabled grant and blocks root mutation until acknowledgment')
  await signal('slow-config-request')
  await wait('slow-config-ready')
  const pending = api('/admin/shares', { targetId, name: 'SlowConfig', path: '/Other', ownerId: original.ownerId }, 'POST', 201)
  void pending.catch(() => {})
  // Observe every client result through the delayed testparm operation and next poll.
  await wait('slow-control-expired')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) { await download(authentication, true); await delay(100) }
  await signal('restore-slow-request')
  await wait('restore-slow-done')
  const temporaryShare = await pending
  await restored(authentication)
  await api('/admin/shares/' + temporaryShare.share.id, undefined, 'DELETE', 204)
  check('an expired policy cannot reopen a native share after slow configuration finishes')
  await signal('superseded-config-request')
  await wait('superseded-config-ready')
  const superseded = api('/admin/shares', { targetId, name: 'SupersededConfig', path: '/Other', ownerId: original.ownerId }, 'POST', 201)
  void superseded.catch(() => {})
  await wait('superseded-config-started')
  const disabling = api('/admin/shares/' + original.id, { enabled: false }, 'PATCH')
  void disabling.catch(() => {})
  await wait('superseded-revision-published')
  const supersededDeadline = Date.now() + 5_000
  while (Date.now() < supersededDeadline) { await download(authentication, true); await delay(100) }
  assert.equal((await disabling).enabled, false)
  await api('/admin/shares/' + original.id, { enabled: true }, 'PATCH')
  await api('/admin/shares/' + (await superseded).share.id, undefined, 'DELETE', 204)
  await restored(authentication)
  check('a policy superseded during slow configuration cannot restore the disabled share')
  await signal('control-write-failure-request')
  await wait('control-write-failure-ready')
  const ownerPassword = 'control-write-owner-password'
  const owner = await api('/admin/users', { username: 'control-owner', password: ownerPassword, role: 'user', grants:[{targetId,scope:'/Other',permissions:{ read: true, download: true, upload: false, create: false, rename: false, delete: false }}], disabled: false }, 'POST', 201)
  const created = await api('/admin/shares', { targetId, name: 'WriteFailure', path: '/Other', ownerId: owner.id }, 'POST', 201)
  assert.match(created.password, /^[A-Za-z0-9_-]{32}$/)
  assert.equal(created.share.status, 'unavailable')
  const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'X-Filebrowser-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: owner.username, password: ownerPassword }) })
  const ownerCookie = login.headers.get('set-cookie').split(';')[0]
  const reset = await fetch(url + '/api/auth/password', { method: 'POST', headers: { cookie: ownerCookie, 'X-Filebrowser-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: ownerPassword, newPassword: 'control-write-new-password' }) })
  assert.equal(reset.status, 200)
  const relogin = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'X-Filebrowser-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: owner.username, password: 'control-write-new-password' }) })
  assert.equal(relogin.status, 200)
  assert.equal((await api('/shares')).available, false)
  await delay(11_000)
  await download(authentication, true)
  await signal('restore-write-request')
  await wait('restore-write-done')
  await restored(authentication)
  await api('/admin/shares/' + created.share.id, undefined, 'DELETE', 204)
  check('control write failures preserve credentials and browser password changes, expire native access, and recover')
  await writeFile(join(output, 'smb-recovery-client-results.json'), JSON.stringify({ status: 'PASS', results }, null, 2))
} catch (error) {
  await writeFile(join(output, 'smb-recovery-client-results.json'), JSON.stringify({ status: 'FAIL', error: error.message, results }, null, 2))
  throw error
} finally { await rm(temporary, { recursive: true, force: true }) }
