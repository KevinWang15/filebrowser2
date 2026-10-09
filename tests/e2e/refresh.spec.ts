import { test, expect, type Page, type Route } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function fixture(page: Page) {
  const api = page.context().request, headers = { 'x-filebrowser-request': '1' }
  const bootstrap = await (await api.get('/api/bootstrap')).json()
  const credentials = { username: 'admin', password: 'browser-test-password-123' }
  const auth = bootstrap.needsSetup
    ? await api.post('/api/setup', { headers, data: { ...credentials, siteName: 'Filebrowser', target: null } })
    : await api.post('/api/auth/login', { headers, data: credentials })
  expect(auth.status()).toBe(bootstrap.needsSetup ? 201 : 200)
  const root = join(process.env.FB_E2E_ROOT!, 'refresh-' + randomUUID())
  await mkdir(join(root, 'Current', 'Nested'), { recursive: true })
  await writeFile(join(root, 'Current', 'original.txt'), 'Original listing')
  await writeFile(join(root, 'Current', 'Nested', 'nested.txt'), 'Nested listing')
  const response = await api.post('/api/admin/targets', { headers, data: {
    name: 'Refresh ' + randomUUID(), enabled: true, readOnly: false, connection: { type: 'local', root },
  } })
  expect(response.status()).toBe(201)
  const target = await response.json()
  await page.goto(`/#/files/${target.id}/Current`)
  await expect(page.getByRole('button', { name: 'original.txt', exact: true })).toBeVisible()
  return { root, target, api, headers, refresh: page.getByRole('button', { name: 'Refresh files', exact: true }) }
}

async function holdListing(page: Page, targetId: string, path: string, failure = false) {
  let captured!: () => void, unblock!: () => void, completed!: () => void, requests = 0
  const entered = new Promise<void>(resolve => { captured = resolve })
  const waiting = new Promise<void>(resolve => { unblock = resolve })
  const finished = new Promise<void>(resolve => { completed = resolve })
  const matches = (url: URL) => url.pathname === `/api/targets/${targetId}/files` && url.searchParams.get('path') === path
  const handler = async (route: Route) => {
    requests++
    const response = await route.fetch()
    captured()
    await waiting
    if (failure) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Refresh fixture unavailable' }) })
    else await route.fulfill({ response })
    completed()
  }
  await page.route(matches, handler)
  return { entered, requests: () => requests, release: async () => { unblock(); await finished; await page.unroute(matches, handler) } }
}

test('button and R refresh the current folder with spinning and timed success feedback', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const f = await fixture(page)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 100))
  await writeFile(join(f.root, 'Current', 'button-added.txt'), 'Created outside the browser')
  await expect(page.getByRole('button', { name: 'button-added.txt', exact: true })).toHaveCount(0)
  const held = await holdListing(page, f.target.id, '/Current')
  await f.refresh.click()
  await held.entered
  await expect(f.refresh).toHaveAttribute('data-state', 'loading')
  await expect(f.refresh).toHaveAttribute('aria-busy', 'true')
  await expect(f.refresh).toBeDisabled()
  await expect(f.refresh.locator(':scope > svg')).toHaveClass(/spin/)
  await expect(f.refresh.locator(':scope > svg')).toHaveCSS('animation-name', 'spin')
  await expect(f.refresh).toHaveCSS('opacity', '1')
  await page.keyboard.press('r')
  await page.keyboard.press('r')
  expect(held.requests()).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('refresh-loading.png'), fullPage: true })
  await held.release()
  await expect(page.getByRole('button', { name: 'button-added.txt', exact: true })).toBeVisible()
  await expect(f.refresh).toHaveAttribute('data-state', 'success')
  await expect(f.refresh).toHaveAttribute('aria-busy', 'false')
  await expect(f.refresh).toBeEnabled()
  await expect(f.refresh.locator(':scope > svg')).not.toHaveClass(/spin/)
  await expect(f.refresh.locator('.refresh-result')).toHaveCSS('transition-duration', '0.1s')
  await expect(f.refresh.locator(':scope > svg')).toHaveCSS('transition-duration', '0.1s')
  await page.clock.runFor(100)
  await expect(f.refresh.locator('.refresh-result')).toHaveCSS('opacity', '1')
  const colors = await f.refresh.evaluate(button => {
    const color = document.createElement('span')
    color.style.backgroundColor = getComputedStyle(button).getPropertyValue('--success')
    return { actual: getComputedStyle(button.querySelector('.refresh-result')!).backgroundColor, expected: color.style.backgroundColor }
  })
  expect(colors.actual).toBe(colors.expected)
  await page.screenshot({ path: testInfo.outputPath('refresh-success.png'), fullPage: true })
  await page.clock.runFor(499)
  await expect(f.refresh).toHaveAttribute('data-state', 'success')
  await page.clock.runFor(1)
  await expect(f.refresh).toHaveAttribute('data-state', 'idle')
  await page.clock.runFor(100)
  await expect(f.refresh.locator('.refresh-result')).toHaveCSS('opacity', '0')
  await expect(f.refresh.locator(':scope > svg')).toHaveCSS('opacity', '1')

  await writeFile(join(f.root, 'Current', 'keyboard-added.txt'), 'Created for the R shortcut')
  const keyboard = await holdListing(page, f.target.id, '/Current')
  await page.keyboard.press('r')
  await keyboard.entered
  await expect(f.refresh).toHaveAttribute('data-state', 'loading')
  await keyboard.release()
  await expect(page.getByRole('button', { name: 'keyboard-added.txt', exact: true })).toBeVisible()
  await expect(f.refresh).toHaveAttribute('data-state', 'success')
  const repeated = await holdListing(page, f.target.id, '/Current')
  await page.keyboard.press('Shift+R')
  await repeated.entered
  await page.clock.runFor(600)
  await expect(f.refresh).toHaveAttribute('data-state', 'loading')
  await repeated.release()
  await expect(f.refresh).toHaveAttribute('data-state', 'success')
  await page.clock.runFor(600)

  await page.getByLabel('Search files', { exact: true }).fill('r')
  let extraRequests = 0
  page.on('request', request => { if (new URL(request.url()).pathname === `/api/targets/${f.target.id}/files`) extraRequests++ })
  await page.keyboard.press('r')
  await expect(page.getByLabel('Search files', { exact: true })).toHaveValue('rr')
  await page.getByLabel('Search files', { exact: true }).fill('')
  await page.getByRole('heading', { name: 'Current', exact: true }).click()
  await page.evaluate(() => {
    const heading = document.querySelector('h1')!
    for (const options of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, ...options }))
  })
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  await page.getByLabel('Folder name').fill('r')
  await page.keyboard.press('r')
  await expect(page.getByLabel('Folder name')).toHaveValue('rr')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(extraRequests).toBe(0)
  expect(errors).toEqual([])
})

test('failed refreshes never show a success tick and retry feedback recovers', async ({ page }, testInfo) => {
  const f = await fixture(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const failed = await holdListing(page, f.target.id, '/Current', true)
  await f.refresh.click()
  await failed.entered
  await expect(f.refresh).toHaveAttribute('data-state', 'loading')
  await expect(f.refresh.locator(':scope > svg')).toHaveCSS('animation-name', 'none')
  await failed.release()
  await expect(page.getByRole('heading', { name: 'Couldn’t open this folder', exact: true })).toBeVisible()
  await expect(page.getByText('Refresh fixture unavailable', { exact: true })).toBeVisible()
  await expect(f.refresh).toHaveAttribute('data-state', 'idle')
  await expect(f.refresh.locator('.refresh-result')).toHaveCSS('opacity', '0')
  await expect(f.refresh).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('refresh-failure.png'), fullPage: true })
  const retry = await holdListing(page, f.target.id, '/Current')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await retry.entered
  await expect(f.refresh).toHaveAttribute('data-state', 'loading')
  await retry.release()
  await expect(page.getByRole('button', { name: 'original.txt', exact: true })).toBeVisible()
  await expect(f.refresh).toHaveAttribute('data-state', 'success')
})

test('navigation and target switching cancel stale refresh results and success timers', async ({ page }) => {
  const f = await fixture(page)
  const held = await holdListing(page, f.target.id, '/Current')
  await f.refresh.click()
  await held.entered
  await page.getByRole('button', { name: 'Nested', exact: true }).click()
  await expect(page.getByRole('button', { name: 'nested.txt', exact: true })).toBeVisible()
  await held.release()
  await expect(f.refresh).toHaveAttribute('data-state', 'idle')
  await expect(page.getByRole('button', { name: 'original.txt', exact: true })).toHaveCount(0)

  const otherRoot = join(process.env.FB_E2E_ROOT!, 'refresh-other-' + randomUUID())
  await mkdir(otherRoot)
  await writeFile(join(otherRoot, 'other.txt'), 'Separate target')
  const other = await f.api.post('/api/admin/targets', { headers: f.headers, data: {
    name: 'Other refresh ' + randomUUID(), connection: { type: 'local', root: otherRoot }, readOnly: false,
  } })
  expect(other.status()).toBe(201)
  const target = await other.json()
  const oldTarget = await holdListing(page, f.target.id, '/Current/Nested')
  await page.keyboard.press('r')
  await oldTarget.entered
  await page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).getByRole('button', { name: 'My files', exact: true }).click()
  await page.getByRole('list', { name: 'Storage targets', exact: true }).getByRole('button', { name: target.name, exact: true }).click()
  await expect(page.getByRole('button', { name: 'other.txt', exact: true })).toBeVisible()
  await oldTarget.release()
  await expect(f.refresh).toHaveAttribute('data-state', 'idle')
  await expect(page.getByRole('button', { name: 'nested.txt', exact: true })).toHaveCount(0)
  await f.refresh.click()
  await expect(f.refresh).toHaveAttribute('data-state', 'success')
  await page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).getByRole('button', { name: 'My files', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'My files', exact: true })).toBeVisible()
})
