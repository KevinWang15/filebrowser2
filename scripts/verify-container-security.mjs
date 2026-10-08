// Disposable production-container checks; fixture files never belong to a deployment.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { get } from 'node:http'
import { mkdir, open, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { READ_PERMISSIONS } from '../shared/types.ts'

const url = process.env.FB_VERIFY_URL ?? 'http://filebrowser.internal:3000'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence/security'
const files = process.env.FB_SECURITY_STORAGE_ROOT
if (!files) throw new Error('Mount the disposable Local fixture volume at FB_SECURITY_STORAGE_ROOT')
const password = 'security-runtime-fixture-password'
const adminPassword = 'target-browser-fixture-password'
const results = [], errors = []
const check = (name, details = {}) => { results.push({ name, status: 'PASS', ...details }); console.log('PASS ' + name) }
const browser = await chromium.launch({ executablePath: process.env.FB_CHROMIUM_PATH, args: ['--no-sandbox'] })
const admin = await browser.newContext({ viewport: { width: 1440, height: 980 } })
const reader = await browser.newContext({ viewport: { width: 1440, height: 980 } })
const api = (context, path, data, method = data === undefined ? 'GET' : 'POST') => context.request.fetch(url + '/api' + path, { method, headers: { 'X-Filebrowser-Request': '1' }, ...(data === undefined ? {} : { data }) })
async function json(response, status = 200) { assert.equal(response.status(), status, await response.text()); return response.json() }
async function login(context, username, secret) { return json(await api(context, '/auth/login', { username, password: secret })) }
const page = await admin.newPage()
page.on('pageerror', error => errors.push(error.message))
let largePath
try {
  await mkdir(join(output, 'screenshots'), { recursive: true })
  await login(admin, 'admin', adminPassword)
  const target = (await json(await api(admin, '/admin/targets'))).find(target => target.name === 'Local')
  assert.ok(target)
  const prefix = `/targets/${target.id}/files`
  for (const name of ['Security review', 'Private review']) await json(await api(admin, prefix + '/directories', { directory: '/', name }))
  await writeFile(join(files, 'Security review', 'visible.txt'), 'This file is within the granted folder.\n', { mode: 0o644 })
  await writeFile(join(files, 'Private review', 'private.txt'), 'This fixture must stay outside the granted folder.\n', { mode: 0o644 })
  await writeFile(join(files, 'Security review', '.FILEBROWSER-private'), 'Reserved namespace fixture', { mode: 0o644 })
  const other = await json(await api(admin, '/admin/targets', { name: 'Security separate target', connection: { type: 'local', root: '/tmp/security-review-other' } }), 201)
  const username = 'security-reader-' + randomUUID().slice(0, 8)
  const grant = { targetId: target.id, scope: '/Security review', permissions: READ_PERMISSIONS }
  const member = await json(await api(admin, '/admin/users', { username, password, role: 'user', grants: [grant] }), 201)
  await login(reader, username, password)
  for (const path of ['/admin/users', '/admin/targets', '/admin/audit', `/targets/${other.id}/files`]) assert.equal((await api(reader, path)).status(), 403)
  check('ordinary account cannot reach administration, audit data or an ungranted target')
  const listing = await json(await api(reader, prefix))
  assert.ok(listing.entries.some(entry => entry.name === 'visible.txt'))
  assert.ok(!listing.entries.some(entry => entry.name.includes('FILEBROWSER') || entry.name === 'private.txt'))
  assert.equal((await api(reader, prefix + '/content?path=/private.txt')).status(), 404)
  for (const path of ['/../Private review/private.txt', '/.FILEBROWSER-private', '/.filebrowser-uploads']) assert.equal((await api(reader, prefix + '/content?path=' + encodeURIComponent(path))).status(), 400)
  check('scope traversal and private namespaces are denied and hidden from directory listings')
  for (const [method, suffix, body] of [['POST', '/directories', { directory: '/', name: 'denied' }], ['PATCH', '', { path: '/visible.txt', name: 'denied.txt' }], ['DELETE', '?path=/visible.txt', undefined]]) assert.equal((await api(reader, prefix + suffix, body, method)).status(), 403)
  check('read-only grant rejects mkdir, rename and deletion through production routes')
  for (const root of ['/files/Security review', '/files-alias', '/files-alias/Security review']) assert.equal((await api(admin, '/admin/targets', { name: 'Overlap fixture', connection: { type: 'local', root } })).status(), 409)
  for (const root of ['/state/targets', '/state-alias', '/files/.filebrowser-uploads']) assert.equal((await api(admin, '/admin/targets', { name: 'Private root fixture', connection: { type: 'local', root } })).status(), 400)
  check('nested targets, real bind-mount aliases and private-state root aliases are rejected')
  for (const path of ['/%61pi/auth/login', '/api/auth/%6cogin']) {
    const blocked = await admin.request.post(url + path, { data: { username: 'admin', password: adminPassword } })
    assert.equal(blocked.status(), 403)
    const foreign = await admin.request.post(url + path, { headers: { 'X-Filebrowser-Request': '1', Origin: 'https://attacker.example' }, data: { username: 'admin', password: adminPassword } })
    assert.equal(foreign.status(), 403)
  }
  check('encoded public API routes enforce both CSRF header and Origin checks')
  const bytes = Buffer.from('retained-upload fixture')
  const limits = (await json(await api(admin, '/bootstrap'))).upload
  const pending = await json(await api(admin, '/uploads', { targetId: target.id, name: 'pending.txt', directory: '/Security review', size: bytes.length, chunkSize: limits.chunkSize, lastModified: 0, hashes: [createHash('sha256').update(bytes).digest('hex')] }), 201)
  assert.equal((await api(reader, '/uploads/' + pending.id)).status(), 404)
  assert.equal((await api(reader, prefix + '/content?path=/pending.txt.uploading')).status(), 409)
  assert.equal((await api(reader, prefix + '/archive-tickets', { paths: ['/pending.txt.uploading'] })).status(), 409)
  await json(await api(admin, '/uploads/' + pending.id, undefined, 'DELETE'))
  check('upload ownership and unfinished-file protection apply to direct and archive downloads')
  const ticket = await json(await api(reader, prefix + '/archive-tickets', { paths: ['/visible.txt'] }))
  assert.equal((await admin.request.get(url + ticket.url)).status(), 404)
  assert.equal((await reader.request.get(url + ticket.url)).status(), 200)
  assert.equal((await reader.request.get(url + ticket.url)).status(), 404)
  check('archive tickets bind the requesting account and can only be consumed once')
  const range = await reader.request.get(url + '/api' + prefix + '/content?path=/visible.txt', { headers: { Range: 'bytes=0-3' } })
  assert.equal(range.status(), 206); assert.equal((await range.body()).toString(), 'This')
  const head = await reader.request.head(url + '/api' + prefix + '/content?path=/visible.txt')
  assert.equal(head.status(), 200); assert.equal(head.headers()['accept-ranges'], 'bytes')
  check('authorized HEAD and byte-range downloads retain native resume behavior')
  largePath = join(files, 'Security review', 'revocation.bin')
  const file = await open(largePath, 'wx', 0o644)
  try { await file.truncate(512 * 1024 * 1024); await file.sync() } finally { await file.close() }
  for (const archive of [false, true]) {
    for (const reason of ['logout', 'grant']) {
      await json(await api(admin, '/admin/users/' + member.id, { username, role: 'user', disabled: false, grants: [grant] }, 'PATCH'))
      await login(reader, username, password)
      const cookie = (await reader.cookies(url)).map(cookie => cookie.name + '=' + cookie.value).join('; ')
      let path = '/api' + prefix + '/content?path=/revocation.bin'
      if (archive) path = (await json(await api(reader, prefix + '/archive-tickets', { paths: ['/revocation.bin'] }))).url
      const response = await new Promise((resolve, reject) => { const request = get(url + path, { headers: { Cookie: cookie } }, resolve); request.once('error', reject) })
      assert.equal(response.statusCode, 200)
      let count = 0, first
      const started = new Promise(resolve => { first = resolve })
      const closed = new Promise(resolve => { response.once('aborted', resolve); response.once('end', resolve); response.once('error', resolve) })
      response.on('data', bytes => { count += bytes.length; if (first) { const ready = first; first = null; response.pause(); ready() } })
      await started
      if (reason === 'logout') assert.equal((await api(reader, '/auth/logout', {})).status(), 204)
      else await json(await api(admin, '/admin/users/' + member.id, { username, role: 'user', disabled: false, grants: [] }, 'PATCH'))
      response.resume()
      await Promise.race([closed, delay(8000).then(() => { throw new Error('Revoked native download remained open') })])
      assert.ok(count < 512 * 1024 * 1024, 'Revoked account received the entire file')
      assert.equal(response.complete, false)
      check(`${archive ? 'archive' : 'file'} production stream aborts after ${reason} revocation`, { receivedBytes: count, logicalFileBytes: 512 * 1024 * 1024 })
    }
  }
  await unlink(largePath); largePath = undefined
  await json(await api(admin, '/admin/users/' + member.id, { username, role: 'user', disabled: false, grants: [grant] }, 'PATCH'))
  await login(reader, username, password)
  await page.goto(url)
  await page.getByRole('button', { name: 'Storage targets', exact: true }).click()
  await page.getByRole('button', { name: 'Add target', exact: true }).click()
  await page.getByLabel('Target name', { exact: true }).fill('Overlapping folder')
  await page.getByLabel('Storage type', { exact: true }).selectOption('local')
  await page.getByLabel('Root directory', { exact: true }).fill('/files/Security review')
  await page.getByRole('button', { name: 'Save target', exact: true }).click()
  await expect(page.getByText('Storage target namespaces must not overlap. Use folder scopes on one target to grant access.', { exact: true })).toBeVisible()
  await page.screenshot({ path: join(output, 'screenshots', 'security-overlap-rejected.png'), fullPage: true })
  const memberPage = await reader.newPage()
  memberPage.on('pageerror', error => errors.push(error.message))
  await memberPage.goto(url + '/#/files/' + target.id)
  await expect(memberPage.getByText('visible.txt', { exact: true })).toBeVisible()
  await expect(memberPage.getByRole('button', { name: 'People & access', exact: true })).toHaveCount(0)
  await expect(memberPage.getByRole('button', { name: 'Storage targets', exact: true })).toHaveCount(0)
  await memberPage.screenshot({ path: join(output, 'screenshots', 'security-scoped-reader.png'), fullPage: true })
  check('browser shows overlap validation and only the reader’s permitted workspace')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'security-results.json'), JSON.stringify({ results, pageErrors: errors }, null, 2) + '\n')
} catch (error) {
  await page.screenshot({ path: join(output, 'screenshots', 'security-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  if (largePath) await unlink(largePath).catch(() => {})
  await browser.close()
}
