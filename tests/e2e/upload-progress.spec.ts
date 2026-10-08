import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FULL_PERMISSIONS } from '../../shared/types'

test('long-name upload progress follows the server upload identity in a member scope', async ({ context }) => {
  const headers = { 'x-filebrowser-request': '1' }, password = 'browser-test-password-123'
  const bootstrap = await (await context.request.get('/api/bootstrap')).json()
  if (bootstrap.needsSetup) {
    expect((await context.request.post('/api/setup', { headers, data: { username: 'admin', password, siteName: 'Filebrowser', target: null } })).status()).toBe(201)
  } else {
    expect((await context.request.post('/api/auth/login', { headers, data: { username: 'admin', password } })).status()).toBe(200)
  }
  const root = join(process.env.FB_E2E_ROOT!, 'long-name-files')
  await mkdir(join(root, 'Scope'), { recursive: true })
  const created = await context.request.post('/api/admin/targets', { headers, data: { name: 'Long names', connection: { type: 'local', root } } })
  expect(created.status()).toBe(201)
  const target = await created.json()
  expect((await context.request.post('/api/admin/users', { headers, data: { username: 'long-name-uploader', password, role: 'user', grants: [{ targetId: target.id, scope: '/Scope', permissions: FULL_PERMISSIONS }] } })).status()).toBe(201)
  const member = await context.browser()!.newContext({ baseURL: 'http://127.0.0.1:3217' })
  let release!: () => void, publishing = false
  const waiting = new Promise<void>(resolve => { release = resolve })
  try {
    expect((await member.request.post('/api/auth/login', { headers, data: { username: 'long-name-uploader', password } })).status()).toBe(200)
    const page = await member.newPage(), name = 'a'.repeat(251) + '.txt'
    await page.route('**/api/uploads/*/complete', async route => { publishing = true; await waiting; await route.continue() })
    await page.goto(`/#/files/${target.id}`)
    await page.getByRole('button', { name: 'Upload files', exact: true }).click()
    await page.locator('input[type=file][multiple]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Upload progress fixture') })
    await expect.poll(() => publishing).toBe(true)
    const sessions = await (await member.request.get('/api/uploads')).json()
    const session = sessions.find((session: { name: string }) => session.name === name)
    expect(session.committedBytes).toBe(session.size)
    const listing = await (await member.request.get(`/api/targets/${target.id}/files`)).json()
    const pending = listing.entries.find((entry: { uploadId?: string }) => entry.uploadId === session.id)
    expect(pending.path).not.toBe('/' + name + '.uploading')
    await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'My files', exact: true }).click()
    await page.getByRole('list', { name: 'Storage targets', exact: true }).getByRole('button', { name: 'Long names', exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: pending.name }).locator('.uploading-badge')).toContainText('100%')
    await page.getByRole('button', { name: 'Grid view', exact: true }).click()
    await expect(page.locator('.file-grid .uploading-badge')).toContainText('100%')
    release()
    await expect.poll(async () => (await (await member.request.get('/api/uploads/' + session.id)).json()).status).toBe('completed')
  } finally { release(); await member.close() }
})
