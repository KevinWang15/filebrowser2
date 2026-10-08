/* global document, window */
import assert from 'node:assert/strict'
import { openTarget } from './verification-targets.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const url = process.env.FB_VERIFY_URL ?? 'http://filebrowser.internal:3000'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence/targets'
const password = 'target-browser-fixture-password'
const hostKey = process.env.FB_TEST_SFTP_HOST_KEY
const results = [], errors = []
const check = name => { results.push({ name, status: 'PASS' }); console.log('PASS ' + name) }
const browser = await chromium.launch({ executablePath: process.env.FB_CHROMIUM_PATH, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 980 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push(error.message))
page.on('dialog', dialog => dialog.dismiss())
const configurations = [
  { name: 'Object store', connection: { type: 's3', bucket: 'filebrowser-test', region: 'us-east-1', endpoint: 'http://minio:9000', prefix: 'browser-targets-' + Date.now(), accessKeyId: 'fixture-access', secretAccessKey: 'container-fixture-secret', forcePathStyle: true } },
  { name: 'Local', connection: { type: 'local', root: '/files' } },
  { name: 'FTP files', connection: { type: 'ftp', host: 'remotes', port: 2121, username: 'fixture', password: 'container-fixture-password', root: '/ftp', tls: false } },
  { name: 'Secure FTP files', connection: { type: 'ftp', host: 'remotes', port: 2122, username: 'fixture', password: 'container-fixture-password', root: '/ftps', tls: true } },
  { name: 'SSH files', connection: { type: 'sftp', host: 'remotes', port: 22, username: 'fixture', password: 'container-fixture-password', root: '/srv/remote/sftp', hostKey } },
]
const labels = { root: 'Root directory', bucket: 'Bucket', region: 'Region', endpoint: 'S3 endpoint', prefix: 'Key prefix', accessKeyId: 'Access key ID', secretAccessKey: 'Secret access key', forcePathStyle: 'Use path-style requests', host: 'Host', port: 'Port', username: 'Remote username', password: 'Remote password', tls: 'Use TLS (FTPS)', hostKey: 'Server host key fingerprint' }
async function request(path, data, method = data === undefined ? 'GET' : 'POST', who = context) {
  return who.request.fetch(url + '/api' + path, { method, headers: { 'X-Filebrowser-Request': '1' }, ...(data === undefined ? {} : { data }) })
}
async function body(response, status = 200) { assert.equal(response.status(), status, await response.text()); return response.json() }
async function shot(name) {
  if (!name.startsWith('failure')) {
    const notifications = page.getByRole('button', { name: 'Dismiss notification', exact: true })
    for (let count = 0; count < 10 && await notifications.count(); count++) await notifications.first().click({ timeout: 1000 }).catch(() => {})
  }
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(output, 'screenshots', name + '.png'), fullPage: true, animations: 'disabled' })
}
async function fields(configuration) {
  await page.getByLabel('Storage type', { exact: true }).selectOption(configuration.connection.type)
  await page.getByLabel('Target name', { exact: true }).fill(configuration.name)
  for (const [field, value] of Object.entries(configuration.connection)) {
    if (field === 'type') continue
    const input = page.getByLabel(labels[field], { exact: true })
    if (typeof value === 'boolean') await input.setChecked(value)
    else await input.fill(String(value))
  }
}
async function upload(target, name, bytes) {
  await page.goto(`${url}/#/files/${target.id}/Shared%20documents`)
  await expect(page.getByRole('heading', { name: 'Shared documents', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Upload files', exact: true }).click()
  await page.getByLabel('Connections per chunk').selectOption('4')
  await page.locator('input[type=file][multiple]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes })
  const row = page.locator('.transfer-row').filter({ hasText: name }).filter({ hasText: target.name })
  await expect(row.getByText('Complete', { exact: true })).toBeVisible({ timeout: 90_000 })
  const downloaded = await request(`/targets/${target.id}/files/content?path=` + encodeURIComponent('/Shared documents/' + name))
  assert.equal(downloaded.status(), 200); assert.deepEqual(await downloaded.body(), bytes)
  return row
}
try {
  await mkdir(join(output, 'screenshots'), { recursive: true })
  const bootstrap = await body(await request('/bootstrap'))
  if (bootstrap.needsSetup) {
    await page.goto(url)
    await page.getByLabel('Workspace name').fill('Storage workspace')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await fields(configurations[0])
    await page.getByLabel('Read only', { exact: true }).uncheck()
    await shot('01-setup-remote-target')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByLabel('Confirm password').fill(password)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'My files', exact: true })).toBeVisible()
    const configured = await body(await request('/targets')); assert.equal(configured.length, 1); assert.equal(configured[0].type, 's3')
    await shot('02-first-run-s3-workspace')
    check('wizard configures S3 first with no implicit local target')
  } else {
    await body(await request('/auth/login', { username: 'admin', password })); await page.goto(url)
  }
  let targets = await body(await request('/admin/targets'))
  for (const configuration of configurations.slice(1)) if (!targets.some(target => target.name === configuration.name)) {
    await page.getByRole('button', { name: 'Storage targets', exact: true }).click()
    await page.getByRole('button', { name: 'Add target', exact: true }).click()
    await fields(configuration)
    await page.getByRole('button', { name: 'Save target', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const row = page.getByRole('row').filter({ has: page.getByText(configuration.name, { exact: true }) })
    await row.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(page.getByText('Connected to “' + configuration.name + '”.', { exact: true })).toBeVisible({ timeout: 30_000 })
    targets = await body(await request('/admin/targets'))
  }
  assert.equal(targets.length, 5)
  await page.getByRole('button', { name: 'Storage targets', exact: true }).click()
  await shot('03-target-administration')
  check('admin adds and verifies Local, FTP, certificate-verified FTPS and pinned-host-key SFTP through browser forms')
  const object = targets.find(target => target.type === 's3')
  await page.getByRole('button', { name: 'Edit target ' + object.name, exact: true }).click()
  await expect(page.getByLabel('Secret access key', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Secret access key', { exact: true })).toHaveAttribute('placeholder', 'Leave blank to keep saved secret')
  await expect(page.getByLabel('Bucket', { exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Save target', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  assert.equal((await request('/admin/targets/' + object.id + '/test', {})).status(), 200)
  check('editing masks saved credentials, preserves blank secrets and locks storage location')
  for (const target of targets) {
    const fileApi = `/targets/${target.id}/files`
    const listing = await body(await request(fileApi))
    if (!listing.entries.some(entry => entry.name === 'Shared documents')) await body(await request(fileApi + '/directories', { directory: '/', name: 'Shared documents' }))
    for (const entry of (await body(await request(fileApi + '?path=/Shared%20documents'))).entries) if (['same-name.txt', 'resume-on-object-store.bin'].includes(entry.name)) await body(await request(fileApi + '?path=' + encodeURIComponent(entry.path), undefined, 'DELETE'))
    const bytes = Buffer.from('独立的文件 · ' + target.name + '\n')
    await upload(target, 'same-name.txt', bytes)
    await page.goto(`${url}/#/files/${target.id}/Shared%20documents`)
    await page.getByLabel('Select same-name.txt', { exact: true }).check()
    const downloading = page.waitForEvent('download')
    await page.locator('.selection-bar').getByRole('button', { name: 'Download', exact: true }).click()
    assert.deepEqual(await readFile(await (await downloading).path()), bytes)
    await shot('files-' + target.name.toLowerCase().replaceAll(' ', '-'))
    await page.reload(); await expect(page.getByRole('heading', { name: 'Shared documents', exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).locator('li')).toHaveText(['My files', target.name, 'Shared documents'])
    assert.ok(page.url().includes('#/files/' + target.id + '/Shared%20documents'))
  }
  check('identical target paths remain independent across actual browser uploads, native downloads and route reloads')
  await page.goto(`${url}/#/transfers/${object.id}`)
  await shot('04-transfers-all-targets')
  assert.equal(await page.locator('.transfer-row').filter({ hasText: 'same-name.txt' }).count(), 5)
  let held
  await page.route('**/api/uploads/*/chunks/1/start', async route => { held = route; await route.abort('connectionreset') })
  const bytes = Buffer.alloc(10 * 1024 * 1024 + 37, 0x6d), name = 'resume-on-object-store.bin'
  await page.goto(`${url}/#/files/${object.id}/Shared%20documents`)
  await page.getByRole('button', { name: 'Upload files', exact: true }).click()
  await page.locator('input[type=file][multiple]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes })
  let row = page.locator('.transfer-row').filter({ hasText: name })
  await expect(row.locator('.state-retrying')).toBeVisible({ timeout: 60_000 }); assert.ok(held)
  const saved = (await body(await request('/uploads'))).find(session => session.name === name)
  assert.equal(saved.targetId, object.id); assert.equal(saved.committedBytes, 5 * 1024 * 1024)
  await row.getByRole('button', { name: 'Pause ' + name, exact: true }).click()
  await page.unroute('**/api/uploads/*/chunks/1/start')
  await page.reload()
  row = page.locator('.transfer-row').filter({ hasText: name })
  await row.getByRole('button', { name: 'Select file', exact: true }).click()
  await page.locator('input[type=file]:not([multiple])').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes })
  await expect(row.getByText('Complete', { exact: true })).toBeVisible({ timeout: 90_000 })
  assert.deepEqual(await (await request(`/targets/${object.id}/files/content?path=/Shared%20documents/` + name)).body(), bytes)
  check('S3 browser reload verifies the source and resumes on its saved target from exactly one acknowledged chunk')
  await page.getByRole('button', { name: 'People & access', exact: true }).click()
  await page.getByRole('button', { name: 'Add a person', exact: true }).click()
  await page.getByLabel('Username', { exact: true }).fill('target-reader')
  await page.getByLabel('Password', { exact: true }).fill(password)
  const card = page.locator('.grant-card').filter({ hasText: object.name })
  await card.getByRole('checkbox').first().check()
  await page.getByLabel(object.name + ' home folder', { exact: true }).fill('/Shared documents')
  await shot('05-per-target-member-grants')
  await page.getByRole('button', { name: 'Add person', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const member = (await body(await request('/admin/users'))).find(user => user.username === 'target-reader')
  assert.equal(member.grants.length, 1); assert.equal(member.grants[0].targetId, object.id)
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 980 } })
  try {
    await body(await request('/auth/login', { username: 'target-reader', password }, 'POST', memberContext))
    const memberPage = await memberContext.newPage(); memberPage.on('pageerror', error => errors.push(error.message))
    await memberPage.goto(url)
    await expect(memberPage.getByRole('list', { name: 'Storage targets', exact: true }).getByRole('button')).toHaveCount(1)
    await openTarget(memberPage, object.name)
    await expect(memberPage.getByRole('button', { name: 'same-name.txt', exact: true })).toBeVisible()
    await expect(memberPage.getByRole('button', { name: 'Upload files', exact: true })).toHaveCount(0)
    const local = targets.find(target => target.type === 'local')
    assert.equal((await request(`/targets/${local.id}/files`, undefined, 'GET', memberContext)).status(), 403)
    await memberPage.screenshot({ path: join(output, 'screenshots', '06-member-scoped-target.png'), fullPage: true })
    await body(await request('/admin/users/' + member.id, { username: member.username, role: 'user', grants: [], disabled: false }, 'PATCH'))
    assert.equal((await request(`/targets/${object.id}/files`, undefined, 'GET', memberContext)).status(), 401)
    await body(await request('/auth/login', { username: 'target-reader', password }, 'POST', memberContext))
    assert.deepEqual(await body(await request('/targets', undefined, 'GET', memberContext)), [])
  } finally { await memberContext.close() }
  check('per-target browser grants scope the root, hide writes, reject other targets and revoke existing sessions')
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 980 })
    await openTarget(page, object.name)
    await page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).getByRole('button', { name: 'My files', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Storage targets', exact: true }).getByRole('button')).toHaveCount(5)
    await expect(page.getByRole('button', { name: object.name, exact: true })).toBeVisible()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Horizontal overflow at ' + width)
    if (width === 390) await shot('07-mobile-target-list')
  }
  check('target list remains usable without horizontal overflow at desktop, tablet and 390/320px mobile widths')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'target-browser-results.json'), JSON.stringify({ status: 'PASS', results, errors, browserVersion: browser.version() }, null, 2))
} catch (error) {
  await shot('failure-target-browser').catch(() => {})
  await writeFile(join(output, 'target-browser-results.json'), JSON.stringify({ status: 'FAIL', results, errors, error: error.stack }, null, 2))
  throw error
} finally { await browser.close() }
