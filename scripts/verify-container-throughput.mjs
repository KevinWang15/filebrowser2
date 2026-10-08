import { verificationTargetId } from './verification-targets.mjs'
/* global document, window */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'

const url = process.env.FB_VERIFY_URL ?? 'http://filebrowser.internal:3000'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence'
const name = 'throughput-layout-' + Date.now() + '.bin'
const bytes = Buffer.alloc(5 * 1024 * 1024, 0x5a)
const samples = [], errors = []
const browser = await chromium.launch({ executablePath: process.env.FB_CHROMIUM_PATH, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 980 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push(error.message))
let requests = 0, targetId
try {
  await mkdir(join(output, 'screenshots'), { recursive: true })
  const login = await context.request.post(url + '/api/auth/login', {
    headers: { 'X-Filebrowser-Request': '1' },
    data: { username: 'admin', password: process.env.FB_VERIFY_ADMIN_PASSWORD ?? 'changed-container-verification-password' },
  })
  assert.equal(login.status(), 200)
  targetId = verificationTargetId(await(await context.request.get(url+'/api/bootstrap')).json())
  await page.goto(url + '/#/transfers/' + targetId)
  await page.route('**/api/uploads/*/attempts/*/parts/*', async route => {
    await delay([0, 25, 700, 50, 350][requests++ % 5])
    await route.continue()
  })
  await page.getByRole('button', { name: 'New upload', exact: true }).click()
  await page.getByLabel('Connections per chunk').selectOption('1')
  await page.locator('input[type=file][multiple]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes })
  const row = page.locator('.transfer-row').filter({ hasText: name })
  await expect(row).toBeVisible()
  const strip = page.locator('.stat-strip')
  const throughput = strip.locator('div').filter({ has: page.getByText('Throughput', { exact: true }) }).locator('strong')
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 980 })
    const measured = []
    for (let index = 0; index < 7; index++) {
      await delay(400)
      const box = await strip.boundingBox()
      const value = await throughput.evaluate(element => ({ text: element.textContent, height: element.getBoundingClientRect().height, lineHeight: parseFloat(window.getComputedStyle(element).lineHeight) }))
      assert.ok(box)
      assert.ok(value.height <= value.lineHeight + 1, 'Throughput wrapped to another line')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      measured.push(box.height)
      samples.push({ width, stripHeight: box.height, ...value })
    }
    assert.ok(Math.max(...measured) - Math.min(...measured) <= 0.5, 'Transfer summary moved as the rate changed')
    await page.screenshot({ path: join(output, 'screenshots', `throughput-${width}.png`), fullPage: true })
  }
  assert.ok(new Set(samples.map(sample => sample.text)).size >= 2, 'Actual transfer speed did not vary')
  await page.setViewportSize({ width: 1440, height: 980 })
  await expect(row.getByText('Complete', { exact: true })).toBeVisible({ timeout: 60_000 })
  const file = await context.request.get(url + `/api/targets/${targetId}/files/content?path=` + encodeURIComponent('/' + name))
  assert.equal(file.status(), 200)
  assert.equal(createHash('sha256').update(await file.body()).digest('hex'), createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(errors, [])
  assert.equal((await context.request.delete(url + `/api/targets/${targetId}/files?path=` + encodeURIComponent('/' + name), { headers: { 'X-Filebrowser-Request': '1' } })).status(), 200)
  await writeFile(join(output, 'throughput-results.json'), JSON.stringify({ status: 'PASS', samples, requests, errors }, null, 2))
  console.log('PASS 21 actual throughput samples keep a single line and fixed summary height at 1440, 768 and 390 pixels')
} catch (error) {
  await writeFile(join(output, 'throughput-results.json'), JSON.stringify({ status: 'FAIL', error: error.message, samples, errors }, null, 2))
  throw error
} finally { await browser.close() }
