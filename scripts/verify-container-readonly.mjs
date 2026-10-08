import { openTarget, verificationTargetId } from './verification-targets.mjs'
/* global document */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { extract } from 'tar-stream'

const url = process.env.FB_VERIFY_URL ?? 'http://filebrowser.internal:3000'
const readonly = process.env.FB_VERIFY_READ_ONLY_URL ?? 'http://readonly:3000'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence'
const password = 'readonly-container-fixture-password'
const bytes = Buffer.from('A physically read-only mount still supports native downloads.\n')
let targetId = ''
const results = [], errors = []
const check = name => { results.push({ name, status: 'PASS' }); console.log('PASS ' + name) }
const browser = await chromium.launch({ executablePath: process.env.FB_CHROMIUM_PATH, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 980 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push(error.message))
async function tarContents(path) {
  const archive = extract(), entries = new Map()
  const reading = (async () => { for await (const entry of archive) {
    const chunks = []; for await (const chunk of entry) chunks.push(chunk)
    entries.set(entry.header.name, Buffer.concat(chunks))
  } })()
  archive.end(await readFile(path)); await reading; return entries
}
try {
  await mkdir(join(output, 'screenshots'), { recursive: true })
  const login = await context.request.post(url + '/api/auth/login', {
    headers: { 'X-Filebrowser-Request': '1' },
    data: { username: 'admin', password: process.env.FB_VERIFY_ADMIN_PASSWORD ?? 'changed-container-verification-password' },
  })
  assert.equal(login.status(), 200)
  targetId = verificationTargetId(await (await context.request.get(url + '/api/bootstrap')).json())
  // Seed only this disposable Compose volume through its writable fixture.
  for (const [directory, name] of [['/', 'Read-only demo'], ['/Read-only demo', 'empty']]) {
    const created = await context.request.post(url + `/api/targets/${targetId}/files/directories`, { headers: { 'X-Filebrowser-Request': '1' }, data: { directory, name } })
    assert.ok([200,409].includes(created.status()), await created.text())
  }
  const bootstrap = await (await context.request.get(url + '/api/bootstrap')).json()
  for (const name of ['notes #1.txt', '文件.uploading']) {
    const existing = await context.request.get(url + `/api/targets/${targetId}/files/content?path=` + encodeURIComponent('/Read-only demo/' + name))
    if (existing.status() === 200) { assert.deepEqual(await existing.body(), bytes); continue }
    const created = await context.request.post(url + '/api/uploads', { headers: { 'X-Filebrowser-Request': '1' }, data: {
      targetId, name, directory: '/Read-only demo', size: bytes.length, lastModified: 0,
      chunkSize: bootstrap.upload.chunkSize, hashes: [createHash('sha256').update(bytes).digest('hex')],
    } })
    assert.equal(created.status(), 201); const session = await created.json()
    const start = await context.request.post(`${url}/api/uploads/${session.id}/chunks/0/start`, { headers: { 'X-Filebrowser-Request': '1' }, data: { connections: 1 } })
    assert.equal(start.status(), 200); const attempt = await start.json()
    const sent = await context.request.put(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/0`, { headers: { 'X-Filebrowser-Request': '1', 'Content-Type': 'application/octet-stream' }, data: bytes })
    assert.equal(sent.status(), 204)
    const commit = await context.request.post(`${url}/api/uploads/${session.id}/chunks/0/commit`, { headers: { 'X-Filebrowser-Request': '1' }, data: { attemptId: attempt.id } })
    assert.equal(commit.status(), 200)
    assert.equal((await context.request.post(`${url}/api/uploads/${session.id}/complete`, { headers: { 'X-Filebrowser-Request': '1' } })).status(), 200)
  }
  // Cookies belong to the individual host; the read-only instance has its own
  // writable account state and must perform its own first-run setup.
  await page.goto(readonly)
  await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible()
  await page.getByLabel('Workspace name').fill('Filebrowser verification')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByLabel('Root directory').fill('/files')
  await page.getByLabel('Read only', {exact:true}).check()
  await page.getByRole('button', {name:'Continue',exact:true}).click()
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Confirm password').fill(password)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'My files', exact: true })).toBeVisible()
  const readonlyBootstrap = await (await context.request.get(readonly + '/api/bootstrap')).json()
  targetId = verificationTargetId(readonlyBootstrap)
  assert.equal(readonlyBootstrap.targets.find(target => target.id === targetId).readOnly, true)
  check('first-run setup writes account state while the file mount is read-only')
  await openTarget(page)
  const rootNames = (await readdir('/verify-files')).sort()
  for (const label of ['New folder', 'Upload files']) await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Read-only demo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Read-only demo', exact: true })).toBeVisible()
  await page.getByLabel('Select notes #1.txt', { exact: true }).check()
  await expect(page.getByRole('button', { name: /^(Rename|Delete)/ })).toHaveCount(0)
  await expect(page.locator('.inspector-preview')).toContainText(bytes.toString().trim())
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(output, 'screenshots', '41-read-only-mount.png'), fullPage: true, animations: 'disabled' })
  check('administrator UI hides file mutations on read-only storage')
  const file = readonly + `/api/targets/${targetId}/files/content?path=` + encodeURIComponent('/Read-only demo/notes #1.txt')
  const head = await context.request.head(file)
  assert.equal(head.status(), 200); assert.equal(head.headers()['content-length'], String(bytes.length))
  const range = await context.request.get(file, { headers: { Range: 'bytes=1-8' } })
  assert.equal(range.status(), 206); assert.deepEqual(await range.body(), bytes.subarray(1, 9))
  const download = page.waitForEvent('download')
  await page.locator('.selection-bar').getByRole('button', { name: 'Download', exact: true }).click()
  assert.deepEqual(await readFile(await (await download).path()), bytes)
  const folder = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download folder', exact: true }).click()
  const archive = await tarContents(await (await folder).path())
  assert.deepEqual(archive.get('notes #1.txt'), bytes); assert.deepEqual(archive.get('文件.uploading'), bytes)
  assert.ok(archive.has('empty/')); assert.equal(archive.size, 3)
  check('native file and TAR downloads retain exact bytes, Unicode names, empty directories and byte ranges')
  const id = '00000000-0000-4000-8000-000000000000'
  for (const [path, method, data] of [
    [`/targets/${targetId}/files/directories`, 'POST', { directory: '/', name: 'blocked' }],
    [`/targets/${targetId}/files`, 'PATCH', { path: '/Read-only demo/notes #1.txt', name: 'blocked.txt' }],
    [`/targets/${targetId}/files?path=/Read-only%20demo/notes%20%231.txt`, 'DELETE'],
    ['/uploads', 'POST', { targetId, name: 'blocked', directory: '/', size: 0, lastModified: 0, chunkSize: readonlyBootstrap.upload.chunkSize, hashes: [] }], [`/uploads/${id}/chunks/0/start`, 'POST', {}],
    [`/uploads/${id}/attempts/${id}/parts/0`, 'PUT', bytes],
    [`/uploads/${id}/chunks/0/commit`, 'POST', { attemptId: id }], [`/uploads/${id}/complete`, 'POST', {}], [`/uploads/${id}`, 'DELETE'],
  ]) {
    const response = await context.request.fetch(readonly + '/api' + path, { method, headers: { 'X-Filebrowser-Request': '1' }, ...(data === undefined ? {} : { data }) })
    assert.equal(response.status(), path.includes(id) ? 404 : 403, path); if (!path.includes(id)) assert.equal((await response.json()).code, 'STORAGE_READ_ONLY', path)
  }
  check('read-only target mutations are denied and nonexistent transfer IDs return 404')
  const member = await context.request.post(readonly + '/api/admin/users', { headers: { 'X-Filebrowser-Request': '1' }, data: {
    username: 'readonly-member', password, role: 'user', grants:[{targetId,scope:'/Read-only demo',permissions:{ read: true, download: true, upload: false, create: false, rename: false, delete: false }}],
  } })
  assert.equal(member.status(), 201)
  assert.deepEqual((await readdir('/verify-files')).sort(), rootNames)
  assert.deepEqual(await readFile('/verify-files/Read-only demo/notes #1.txt'), bytes)
  check('user administration remains writable and file storage remains unchanged')
  await page.getByRole('button', { name: 'Transfers', exact: true }).click()
  await expect(page.getByText('Storage is read-only.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New upload', exact: true })).toHaveCount(0)
  assert.deepEqual(errors, []); check('read-only transfer controls and browser error handling remain consistent')
  await writeFile(join(output, 'read-only-results.json'), JSON.stringify({ status: 'PASS', results, errors, browserVersion: browser.version() }, null, 2))
} catch (error) {
  await page.screenshot({ path: join(output, 'screenshots', 'failure-read-only.png'), fullPage: true }).catch(() => {})
  await writeFile(join(output, 'read-only-results.json'), JSON.stringify({ status: 'FAIL', results, errors, error: error.stack }, null, 2))
  throw error
} finally { await browser.close() }
