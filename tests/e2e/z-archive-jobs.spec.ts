import { test, expect, type Page } from '@playwright/test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ARCHIVE_FORMATS, type ArchiveJob } from '../../shared/types'

async function fixture(page: Page) {
  const api = page.context().request, headers = { 'x-filebrowser-request': '1' }
  const bootstrap = await (await api.get('/api/bootstrap')).json()
  const credentials = { username: 'admin', password: 'browser-test-password-123' }
  const auth = bootstrap.needsSetup
    ? await api.post('/api/setup', { headers, data: { ...credentials, siteName: 'Filebrowser', target: null } })
    : await api.post('/api/auth/login', { headers, data: credentials })
  expect(auth.status()).toBe(bootstrap.needsSetup ? 201 : 200)
  const root = join(process.env.FB_E2E_ROOT!, 'archive-' + randomUUID())
  await mkdir(join(root, 'folder', 'empty'), { recursive: true })
  await mkdir(join(root, 'folder', '子目录'))
  await writeFile(join(root, 'folder', '文件.txt'), 'Archive UI fixture')
  await writeFile(join(root, 'folder', '.hidden'), 'Hidden file')
  await writeFile(join(root, 'folder', '@literal[1]*?.txt'), 'Literal wildcard file')
  const binary = Buffer.alloc(257 * 1024)
  for (let index = 0; index < binary.length; index++) binary[index] = index % 251
  await writeFile(join(root, 'folder', '子目录', 'binary.bin'), binary)
  await writeFile(join(root, 'extra.txt'), 'Second selection')
  await writeFile(join(root, 'zero'), '')
  const response = await api.post('/api/admin/targets', { headers, data: { name: 'Archives ' + randomUUID(), connection: { type: 'local', root } } })
  expect(response.status()).toBe(201); const target = await response.json()
  return { root, target, api, headers, url: `/#/files/${target.id}` }
}

for (const format of ARCHIVE_FORMATS) test(`${format}: Compress and Decompress round-trip through the browser and retain jobs after reload`, async ({ page }, testInfo) => {
  const { root, target, url } = await fixture(page), name = 'bundle.' + format
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.getByRole('checkbox', { name: 'Select folder', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Select extra.txt', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Select zero', exact: true }).check()
  await page.getByRole('button', { name: 'Compress', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Compress', exact: true })
  await dialog.getByLabel('Format', { exact: true }).selectOption(format)
  await dialog.getByLabel('Archive name', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: 'Compress', exact: true }).click()
  const operations = page.getByRole('region', { name: 'Compress and Decompress operations', exact: true })
  const targetJobs = operations.locator('.archive-job').filter({ hasText: target.name })
  const compressed = targetJobs.filter({ hasText: '/' + name })
  await expect(compressed).toContainText('Complete')
  await expect(compressed).toContainText('100%')
  // Independently validate the generated format with the upstream command-line reader.
  const validation = await promisify(execFile)(process.env.FB_7ZIP_PATH || '7zz', ['t', '-bd', '--', join(root, name)])
  expect(validation.stdout).toContain('Everything is Ok')
  await testInfo.attach('native-archive-validation', { body: validation.stdout, contentType: 'text/plain' })
  await page.reload()
  await expect(compressed).toContainText('Complete')
  await page.goto(url)
  await page.getByRole('checkbox', { name: 'Select ' + name, exact: true }).check()
  await page.getByRole('button', { name: 'Decompress', exact: true }).click()
  const extract = page.getByRole('dialog', { name: 'Decompress', exact: true })
  await extract.getByLabel('Destination folder name', { exact: true }).fill('restored')
  await extract.getByRole('button', { name: 'Decompress', exact: true }).click()
  await expect(targetJobs.filter({ hasText: '/restored' })).toContainText('Complete')
  for (const path of ['folder/文件.txt', 'folder/.hidden', 'folder/@literal[1]*?.txt', 'folder/子目录/binary.bin', 'extra.txt', 'zero']) {
    expect(await readFile(join(root, 'restored', path))).toEqual(await readFile(join(root, path)))
  }
  expect(await readdir(join(root, 'restored', 'folder', 'empty'))).toEqual([])
  await page.goto(url)
  await expect(page.getByRole('button', { name: 'restored', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'restored', exact: true }).click()
  await expect(page.getByRole('button', { name: 'folder', exact: true })).toBeVisible()
  await page.goto(`/#/transfers/${target.id}`)
  await page.screenshot({ path: testInfo.outputPath('archive-progress.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('real 7z compression shows live progress, survives reload and cancels cleanly from Transfers', async ({ page }, testInfo) => {
  const { root, target, url, api } = await fixture(page)
  const source = join(root, 'large.bin'), handle = await open(source, 'wx')
  try { for (let index = 0; index < 16; index++) await handle.writeFile(randomBytes(4 * 1024 * 1024)) }
  finally { await handle.close() }
  const checksum = async () => {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(source)) hash.update(bytes)
    return hash.digest('hex')
  }
  const before = await checksum()
  await page.goto(url)
  await page.getByRole('checkbox', { name: 'Select large.bin', exact: true }).check()
  await page.getByRole('button', { name: 'Compress', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Compress', exact: true })
  await dialog.getByLabel('Format', { exact: true }).selectOption('7z')
  await dialog.getByLabel('Archive name', { exact: true }).fill('cancel.7z')
  const started = page.waitForResponse(response => response.url().endsWith(`/targets/${target.id}/archive-jobs`) && response.request().method() === 'POST')
  await dialog.getByRole('button', { name: 'Compress', exact: true }).click()
  const job: ArchiveJob = await (await started).json()
  const card = page.getByRole('region', { name: 'Compress and Decompress operations', exact: true }).locator('.archive-job').filter({ hasText: '/cancel.7z' })
  await expect(card).toContainText('Compressing')
  await expect.poll(async () => Number(await card.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0)
  await page.reload()
  await expect(card.getByRole('button', { name: 'Cancel compress /cancel.7z', exact: true })).toBeVisible()
  const percent = Number(await card.getByRole('progressbar').getAttribute('aria-valuenow'))
  expect(percent).toBeGreaterThan(0); expect(percent).toBeLessThan(100)
  await page.screenshot({ path: testInfo.outputPath('live-progress.png'), fullPage: true })
  await card.getByRole('button', { name: 'Cancel compress /cancel.7z', exact: true }).click()
  await expect(card).toContainText('Canceled')
  await expect(card.getByRole('button')).toHaveCount(0)
  await expect.poll(async () => (await (await api.get('/api/archive-jobs')).json() as ArchiveJob[]).find(item => item.id === job.id)?.status).toBe('canceled')
  await expect(access(join(root, 'cancel.7z'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(join(process.env.FB_E2E_ROOT!, 'state', 'archive-work', job.id))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await stat(source)).size).toBe(64 * 1024 * 1024)
  expect(await checksum()).toBe(before)
  // Start a fresh operation from the context menu to verify cancellation released its slot.
  await page.goto(url)
  await page.getByRole('button', { name: 'More actions for extra.txt', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Compress…', exact: true }).click()
  await page.getByLabel('Archive name', { exact: true }).fill('after-cancel.zip')
  await page.getByRole('dialog', { name: 'Compress', exact: true }).getByRole('button', { name: 'Compress', exact: true }).click()
  await expect(page.locator('.archive-job').filter({ hasText: '/after-cancel.zip' })).toContainText('Complete')
})

test('Decompress reports destination conflicts and invalid archives without overwriting files', async ({ page }, testInfo) => {
  const { root, url } = await fixture(page)
  await writeFile(join(root, 'broken.zip'), 'This is not a ZIP archive')
  await mkdir(join(root, 'existing'))
  await writeFile(join(root, 'existing', 'keep.txt'), 'Keep this file')
  await page.goto(url)
  await page.getByRole('button', { name: 'More actions for broken.zip', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Decompress…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Decompress', exact: true })
  await dialog.getByLabel('Destination folder name', { exact: true }).fill('existing')
  await dialog.getByRole('button', { name: 'Decompress', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('destination already exists')
  expect(await readFile(join(root, 'existing', 'keep.txt'), 'utf8')).toBe('Keep this file')
  await dialog.getByLabel('Destination folder name', { exact: true }).fill('failed-output')
  await dialog.getByRole('button', { name: 'Decompress', exact: true }).click()
  const card = page.locator('.archive-job').filter({ hasText: '/failed-output' })
  await expect(card).toContainText('Failed')
  await expect(card.getByRole('alert')).toBeVisible()
  await expect(access(join(root, 'failed-output'))).rejects.toMatchObject({ code: 'ENOENT' })
  await page.reload()
  await expect(card).toContainText('Failed')
  await page.screenshot({ path: testInfo.outputPath('invalid-archive.png'), fullPage: true })
})
