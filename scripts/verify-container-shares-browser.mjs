import { verificationTargetId } from './verification-targets.mjs'
/* global document, window */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const url = process.env.FB_VERIFY_URL ?? 'http://filebrowser.internal:3000'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence'
let targetId
const results = [], errors = []
const check = name => { results.push({ name, status: 'PASS' }); console.log('PASS ' + name) }
await mkdir(join(output, 'screenshots'), { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.FB_CHROMIUM_PATH ? { executablePath: process.env.FB_CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 980 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push(error.message))
async function api(path, data) {
  const response = await context.request.post(url + '/api' + path, { headers: { 'X-Filebrowser-Request': '1' }, data })
  assert.ok(response.ok(), await response.text())
  return response.json()
}
try {
  await api('/auth/login', { username: 'admin', password: 'protocol-container-admin-password' })
  targetId = verificationTargetId(await (await context.request.get(url + '/api/bootstrap')).json())
  const previous = await (await context.request.get(url + '/api/shares')).json()
  for (const share of previous.shares.filter(share => ['BrowserDocs', 'BrowserAgain'].includes(share.name))) {
    const response = await context.request.delete(url + '/api/admin/shares/' + share.id, { headers: { 'X-Filebrowser-Request': '1' } })
    assert.equal(response.status(), 204)
  }
  const memberName = 'browser-reader-' + Math.random().toString(36).slice(2, 8)
  const member = await api('/admin/users', { username: memberName, password: 'protocol-browser-reader-password', role: 'user', grants:[{targetId,scope:'/Other',permissions:{ read: true, download: true, upload: false, create: false, rename: false, delete: false }}], disabled: false })
  await page.goto(url + '/#/settings')
  const panel = page.getByRole('region', { name: 'Network shares', exact: true })
  await expect(panel.getByText('SMB service connected.', { exact: false })).toBeVisible()
  await panel.getByLabel('Share name').fill('BrowserDocs')
  await panel.getByLabel('Directory', { exact: true }).fill('/Other')
  await panel.getByLabel('Access as').selectOption(member.id)
  await panel.getByRole('button', { name: 'Create share', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'SMB connection', exact: true })).toBeVisible()
  const password = await page.getByLabel('SMB password', { exact: true }).inputValue()
  const username = await page.getByLabel('SMB username', { exact: true }).inputValue()
  assert.match(password, /^[A-Za-z0-9_-]{32}$/)
  await expect(page.getByLabel('SMB password', { exact: true })).toHaveAttribute('type', 'password')
  await page.screenshot({ path: join(output, 'screenshots', 'smb-credentials.png'), fullPage: true })
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByLabel('SMB password', { exact: true })).toHaveCount(0)
  const share = panel.getByRole('article', { name: 'Share BrowserDocs', exact: true })
  await expect(share.getByText('active', { exact: true })).toBeVisible()
  check('administrator creates a scoped share and receives a masked one-time protocol password')
  await share.getByRole('button', { name: 'Disable', exact: true }).click()
  await expect(share.getByText('disabled', { exact: true })).toBeVisible()
  await share.getByRole('button', { name: 'Enable', exact: true }).click()
  await expect(share.getByText('active', { exact: true })).toBeVisible()
  await share.getByRole('button', { name: 'Reset password', exact: true }).click()
  await expect(page.getByLabel('SMB password', { exact: true })).toBeVisible()
  assert.notEqual(await page.getByLabel('SMB password', { exact: true }).inputValue(), password)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  check('browser share controls disable, enable and rotate protocol credentials')
  await panel.getByLabel('Share name').fill('BrowserAgain')
  await panel.getByRole('button', { name: 'Create share', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'SMB connection', exact: true })).toBeVisible()
  assert.equal(await page.getByLabel('SMB username', { exact: true }).inputValue(), username)
  await expect(page.getByLabel('SMB password', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Use this user’s existing SMB password for this additional share.')).toBeVisible()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  check('additional folders reuse the same SMB account without resetting its password')
  await page.setViewportSize({ width: 1440, height: 1500 })
  await page.locator('.page-scroll').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: join(output, 'screenshots', 'smb-admin-console.png'), fullPage: true })
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 980 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    await expect(share.getByRole('button', { name: 'Copy address' })).toBeVisible()
  }
  await page.locator('.page-scroll').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: join(output, 'screenshots', 'smb-mobile.png'), fullPage: true })
  check('sharing controls remain visible without horizontal overflow at tablet and mobile widths')
  await context.clearCookies()
  await api('/auth/login', { username: memberName, password: 'protocol-browser-reader-password' })
  // API login changes cookies; reload the document to bootstrap the new identity.
  await page.reload()
  await expect(panel.getByRole('article', { name: 'Share BrowserDocs', exact: true })).toBeVisible()
  await expect(panel.getByRole('article', { name: 'Share BrowserAgain', exact: true })).toBeVisible()
  await expect(panel.getByRole('article', { name: 'Share Other', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Create share', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Reset password', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0)
  await page.screenshot({ path: join(output, 'screenshots', 'smb-member-view.png'), fullPage: true })
  check('non-administrators see only assigned connection information and cannot manage shares')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'smb-browser-results.json'), JSON.stringify({ status: 'PASS', browser: await browser.version(), results, pageErrors: errors }, null, 2))
} catch (error) {
  await page.screenshot({ path: join(output, 'screenshots', 'smb-browser-failure.png'), fullPage: true }).catch(() => {})
  await writeFile(join(output, 'smb-browser-results.json'), JSON.stringify({ status: 'FAIL', error: error.message, results, pageErrors: errors }, null, 2))
  throw error
} finally { await browser.close() }
