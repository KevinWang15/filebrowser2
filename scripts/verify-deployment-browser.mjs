/* global document */
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const url = process.env.FB_VERIFY_URL ?? 'http://127.0.0.1:17289'
const output = 'deployment/verification'
const screenshots = join(output, 'screenshots')
await mkdir(screenshots, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.FB_CHROMIUM_PATH, args: ['--no-sandbox'] })
const errors = []
const requests = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('requestfailed', request => errors.push(request.url() + ': ' + request.failure()?.errorText))
  page.on('response', response => requests.push({ path: new URL(response.url()).pathname, status: response.status() }))
  await page.goto(url)
  await page.getByRole('heading', { name: 'Make yourself at home.' }).waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(screenshots, '01-production-setup-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByLabel('Username', { exact: true }).waitFor()
  await page.screenshot({ path: join(screenshots, '02-production-setup-administrator.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(url)
  await page.getByRole('heading', { name: 'Make yourself at home.' }).waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(screenshots, '03-production-setup-mobile.png'), fullPage: true })
  assert.deepEqual(errors, [])
  const bootstrap = await (await context.request.get(url + '/api/bootstrap')).json()
  assert.equal(bootstrap.needsSetup, true)
  assert.equal(bootstrap.user, null)
  assert.ok(requests.some(request => /\.woff2$/.test(request.path) && request.status === 200))
  assert.ok(requests.every(request => request.status < 400))
  await writeFile(join(output, 'remote-browser-results.json'), JSON.stringify({ status: 'PASS', url, screenshots: ['01-production-setup-desktop.png', '02-production-setup-administrator.png', '03-production-setup-mobile.png'], errors, requests, bootstrap, setupSubmitted: false }, null, 2) + '\n')
  console.log('PASS production setup renders on desktop and mobile through SSH, loads bundled assets/fonts, and leaves setup unsubmitted')
} finally { await browser.close() }
