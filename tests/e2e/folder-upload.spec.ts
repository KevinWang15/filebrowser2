import { test, expect, type Locator } from '@playwright/test'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FULL_PERMISSIONS } from '../../shared/types'

async function dropFolder(locator: Locator, name: string) {
  await locator.evaluate((element, name) => {
    const file = new File(['Dropped content'], 'dropped.txt')
    const leaf = { name: file.name, isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(file) }
    const folder = { name, isFile: false, isDirectory: true, createReader() {
      let read = false
      return { readEntries(resolve: (entries: unknown[]) => void) { resolve(read ? [] : [leaf]); read = true } }
    } }
    const data = new DataTransfer()
    data.items.add(file)
    Object.defineProperty(data, 'items', { value: [{ kind: 'file', webkitGetAsEntry: () => folder }] })
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  }, name)
}

test('folder uploads preserve paths and resume after reload; folder deletion removes contents and reports partial failures', async ({ page, context }, testInfo) => {
  const root = process.env.FB_E2E_ROOT!, headers = { 'x-filebrowser-request': '1' }
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const bootstrap = await (await context.request.get('/api/bootstrap')).json()
  if (bootstrap.needsSetup) {
    expect((await context.request.post('/api/setup', { headers, data: { username: 'admin', password: 'browser-test-password-123', siteName: 'Filebrowser', target: null } })).status()).toBe(201)
  } else {
    expect((await context.request.post('/api/auth/login', { headers, data: { username: 'admin', password: 'browser-test-password-123' } })).status()).toBe(200)
  }
  const targetRoot = join(root, 'folder-files'), sourceRoot = join(root, 'folder-sources', 'Project')
  const sourceFiles = new Map([
    ['a/same.txt', Buffer.from('first duplicate basename')],
    ['b/same.txt', Buffer.from('second duplicate basename')],
    ['文档 #1/data %.txt', Buffer.from('Unicode and URL punctuation')],
    ['zero.txt', Buffer.alloc(0)],
    ['b/resume.bin', Buffer.alloc(1024 * 1024, 0x63)],
  ])
  for (const [path, content] of sourceFiles) {
    await mkdir(join(sourceRoot, path, '..'), { recursive: true })
    await writeFile(join(sourceRoot, path), content)
  }
  await mkdir(join(sourceRoot, 'Empty'), { recursive: true })
  await mkdir(join(targetRoot, 'Incoming', 'Project', 'a'), { recursive: true })
  await writeFile(join(targetRoot, 'Incoming', 'Project', 'a', 'unrelated.txt'), 'preserved')
  const response = await context.request.post('/api/admin/targets', { headers, data: { name: 'Folder uploads', enabled: true, readOnly: false, connection: { type: 'local', root: targetRoot } } })
  expect(response.status()).toBe(201)
  const target = await response.json()
  await page.goto(`/#/files/${target.id}/Incoming`)
  await page.getByRole('button', { name: 'Upload files', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Choose folder', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 320, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('folder-picker-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 980 })

  let resumeId = '', interrupted = false
  await page.route('**/api/uploads', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const result = await route.fetch()
    if (route.request().postDataJSON().name === 'resume.bin') resumeId = (await result.json()).id
    await route.fulfill({ response: result })
  })
  await page.route('**/api/uploads/*/chunks/0/start', async route => {
    if (resumeId && route.request().url().includes(`/uploads/${resumeId}/`)) { interrupted = true; await route.abort('failed') }
    else await route.continue()
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await (await chooser).setFiles(sourceRoot)
  const rows = page.locator('.transfer-row').filter({ hasText: 'Folder uploads ·' })
  await expect(rows).toHaveCount(sourceFiles.size)
  await expect.poll(() => interrupted).toBe(true)
  const resumedRow = rows.filter({ hasText: 'resume.bin' })
  await expect(resumedRow).toContainText('/Incoming/Project/b')
  await resumedRow.getByRole('button', { name: 'Pause resume.bin', exact: true }).click()
  await expect(resumedRow).toContainText('Paused')
  await expect(rows.locator('.state-completed')).toHaveCount(sourceFiles.size - 1)
  await page.reload()
  await page.unroute('**/api/uploads')
  await page.unroute('**/api/uploads/*/chunks/0/start')
  await expect(resumedRow).toContainText('Ready to resume')
  await resumedRow.getByRole('button', { name: 'Select file', exact: true }).click()
  await page.locator('input[type=file]:not([multiple])').setInputFiles(join(sourceRoot, 'b', 'resume.bin'))
  await expect(rows.locator('.state-completed')).toHaveCount(sourceFiles.size)
  for (const [path, content] of sourceFiles) expect(await readFile(join(targetRoot, 'Incoming', 'Project', path))).toEqual(content)
  expect(await readFile(join(targetRoot, 'Incoming', 'Project', 'a', 'unrelated.txt'), 'utf8')).toBe('preserved')
  await expect(stat(join(targetRoot, 'Incoming', 'Project', 'Empty'))).rejects.toMatchObject({ code: 'ENOENT' })
  const sessions = (await (await context.request.get('/api/uploads')).json()).filter((session: { targetId: string }) => session.targetId === target.id)
  expect(sessions).toHaveLength(sourceFiles.size)
  expect(sessions.every((session: { status: string }) => session.status === 'completed')).toBe(true)
  expect(sessions.filter((session: { name: string }) => session.name === 'same.txt').map((session: { directory: string }) => session.directory).sort()).toEqual(['/Incoming/Project/a', '/Incoming/Project/b'])
  await page.screenshot({ path: testInfo.outputPath('folder-transfers.png'), fullPage: true })

  // Drop a directory onto a folder row. The row must use the same relative-path intake as the dialog.
  await page.goto(`/#/files/${target.id}`)
  const incoming = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Incoming', exact: true }) })
  await expect(incoming).toBeVisible()
  await dropFolder(incoming, 'Dropped')
  await expect.poll(async () => readFile(join(targetRoot, 'Incoming', 'Dropped', 'dropped.txt'), 'utf8').catch(() => '')).toBe('Dropped content')
  await dropFolder(page.locator('.files-view'), 'Root drop')
  await expect(page.getByRole('button', { name: 'Root drop', exact: true })).toBeVisible()
  await expect.poll(async () => readFile(join(targetRoot, 'Root drop', 'dropped.txt'), 'utf8').catch(() => '')).toBe('Dropped content')
  await page.getByRole('button', { name: 'Upload files', exact: true }).click()
  await dropFolder(page.locator('.dropzone'), 'Dialog drop')
  await expect(page.getByRole('heading', { name: 'Transfers', exact: true })).toBeVisible()
  await expect(page.locator('.transfer-row').filter({ hasText: '/Dialog drop' })).toContainText('Complete')
  expect(await readFile(join(targetRoot, 'Dialog drop', 'dropped.txt'), 'utf8')).toBe('Dropped content')

  // File-only upload grants retain ordinary uploads but cannot create a folder tree.
  const person = await context.request.post('/api/admin/users', { headers, data: { username: 'file-only', password: 'file-only-password-123', role: 'user', grants: [{ targetId: target.id, scope: '/Incoming', permissions: { ...FULL_PERMISSIONS, create: false } }] } })
  expect(person.status()).toBe(201)
  const member = await context.browser()!.newContext({ baseURL: 'http://127.0.0.1:3217' })
  try {
    expect((await member.request.post('/api/auth/login', { headers, data: { username: 'file-only', password: 'file-only-password-123' } })).status()).toBe(200)
    const memberPage = await member.newPage()
    await memberPage.goto(`/#/files/${target.id}`)
    await memberPage.getByRole('button', { name: 'Upload files', exact: true }).click()
    await expect(memberPage.getByRole('button', { name: 'Choose folder', exact: true })).toHaveCount(0)
    await dropFolder(memberPage.locator('.dropzone'), 'Forbidden folder')
    await expect(memberPage.getByText('You need create permission to upload folders.', { exact: true })).toBeVisible()
    await expect(stat(join(targetRoot, 'Incoming', 'Forbidden folder'))).rejects.toMatchObject({ code: 'ENOENT' })
    await memberPage.locator('input[type=file][multiple]').setInputFiles({ name: 'ordinary.txt', mimeType: 'text/plain', buffer: Buffer.from('file-only upload') })
    await expect(memberPage.locator('.transfer-row').filter({ hasText: 'ordinary.txt' })).toContainText('Complete')
    expect(await readFile(join(targetRoot, 'Incoming', 'ordinary.txt'), 'utf8')).toBe('file-only upload')
  } finally { await member.close() }
  await page.goto(`/#/files/${target.id}/Incoming`)
  await page.getByLabel('Select Project', { exact: true }).check()
  await page.getByRole('button', { name: 'Delete selected items', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Folders and all their contents will be permanently deleted.')
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Project', exact: true })).toHaveCount(0)
  await expect(stat(join(targetRoot, 'Incoming', 'Project'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(targetRoot, 'Incoming', 'ordinary.txt'), 'utf8')).toBe('file-only upload')

  await mkdir(join(targetRoot, 'Incoming', 'Protected', '.filebrowser-private'), { recursive: true })
  await writeFile(join(targetRoot, 'Incoming', 'Protected', 'removed.txt'), 'removed before failure')
  await writeFile(join(targetRoot, 'Incoming', 'Protected', '.filebrowser-private', 'keep.txt'), 'private')
  await page.getByRole('button', { name: 'Refresh files', exact: true }).click()
  await page.getByLabel('Select Protected', { exact: true }).check()
  let refreshed = false
  page.on('request', request => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === `/api/targets/${target.id}/files` && url.searchParams.get('path') === '/Incoming') refreshed = true
  })
  await page.getByRole('button', { name: 'Delete selected items', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('protected or unsupported entries')
  await expect.poll(() => refreshed).toBe(true)
  await expect(stat(join(targetRoot, 'Incoming', 'Protected', 'removed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(targetRoot, 'Incoming', 'Protected', '.filebrowser-private', 'keep.txt'), 'utf8')).toBe('private')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  expect(errors).toEqual([])
})
