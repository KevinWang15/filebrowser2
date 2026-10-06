/* global document, window */
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const url = process.env.FB_VERIFY_URL ?? 'http://filebrowser.internal:3000'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence'
const folder = 'Team documents' + (process.env.FB_VERIFY_RUN_SUFFIX ?? '')
const notes = 'project-notes' + (process.env.FB_VERIFY_RUN_SUFFIX ?? '') + '.md'
const screenshots = join(output, 'screenshots')
const results = []
const errors = []
const browser = await chromium.launch({ executablePath: process.env.FB_CHROMIUM_PATH, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 980 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push(error.message))
const check = name => { results.push({ name, status: 'PASS' }); console.log('PASS ' + name) }
async function shot(name) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(screenshots, name + '.png'), fullPage: true, animations: 'disabled' })
}
async function palette(command) {
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Command' }).fill(command)
}

try {
  await mkdir(screenshots, { recursive: true })
  await page.goto(url)
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill(process.env.FB_VERIFY_ADMIN_PASSWORD ?? 'changed-container-verification-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'My files', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('group', { name: 'Theme', exact: true }).getByRole('button', { name: 'Light', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'My files', exact: true }).first().click()
  await page.getByRole('button', { name: 'List view', exact: true }).click()
  await expect(page.getByRole('button', { name: 'one-gib-verified.bin', exact: true })).toBeVisible()
  await shot('28-redesigned-light-workspace')
  await page.getByLabel('Select one-gib-verified.bin', { exact: true }).check()
  if (await page.getByRole('button', { name: 'Toggle details' }).getAttribute('aria-pressed') === 'false') {
    await page.getByRole('button', { name: 'Toggle details' }).click()
  }
  await expect(page.getByRole('complementary', { name: 'Details' })).toContainText('1 GiB')
  await shot('29-file-inspector')
  check('file selection updates the details inspector with the verified fixture size')

  await page.getByRole('button', { name: folder, exact: true }).click()
  await expect(page.getByRole('heading', { name: folder, exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: folder, exact: true })).toBeVisible()
  assert.match(page.url(), /#\/files\/Team%20documents/)
  await page.getByRole('button', { name: 'My files', exact: true }).last().click()
  await expect(page.getByRole('heading', { name: 'My files', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: folder, exact: true })).toBeVisible()
  await page.goForward()
  await expect(page.getByRole('heading', { name: 'My files', exact: true })).toBeVisible()
  check('encoded folder routes survive reload and browser back/forward navigation')

  await palette('/' + folder)
  await expect(page.getByRole('option', { name: 'Open folder /' + folder, exact: true })).toBeVisible()
  await shot('30-command-palette-folder')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: folder, exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  check('Ctrl+K and Enter open a folder through the command palette')

  await page.getByLabel('Search files').fill(notes)
  await expect(page.locator('.file-row')).toHaveCount(1)
  await expect(page.getByRole('button', { name: notes, exact: true })).toBeVisible()
  await page.getByLabel('Search files').fill('no-such-redesign-file')
  await expect(page.getByRole('heading', { name: 'No matches', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear filter', exact: true }).click()
  await expect(page.locator('.file-row')).toHaveCount(2)
  await page.getByRole('button', { name: 'Name', exact: true }).click()
  await expect(page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: 'Name', exact: true }) })).toHaveAttribute('aria-sort', 'descending')
  await page.getByRole('button', { name: 'Name', exact: true }).click()
  check('folder filtering, empty results, reset, and accessible sort direction work')

  await page.getByRole('button', { name: 'More actions for ' + notes, exact: true }).click()
  const menu = page.getByRole('menu')
  for (const name of ['Open', 'Download', 'Rename', 'Delete']) {
    await expect(menu.getByRole('menuitem', { name: new RegExp('^' + name + '(?:\\s|$)') })).toBeVisible()
  }
  await shot('31-file-context-menu')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  check('file overflow menu exposes permitted actions and Escape dismisses it')

  await palette('Use dark theme')
  await page.keyboard.press('Enter')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await shot('32-redesigned-dark-workspace')
  await page.getByRole('button', { name: 'Grid view', exact: true }).click()
  await expect(page.locator('.file-card')).toHaveCount(2)
  await shot('33-redesigned-dark-grid')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.file-card')).toHaveCount(2)
  check('theme command and grid layout persist after reload')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('group', { name: 'Density', exact: true }).getByRole('button', { name: 'Comfortable', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-density', 'comfortable')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByText('100 KiB', { exact: true })).toBeVisible()
  await shot('34-redesigned-dark-settings')
  check('settings theme and density persist while showing actual server upload limits')

  await page.getByRole('button', { name: 'Transfers', exact: true }).click()
  await page.getByRole('group', { name: 'Filter transfers' }).getByRole('button', { name: /^Completed/ }).click()
  await expect(page.locator('.transfer-row').first()).toBeVisible()
  assert.equal(await page.locator('.transfer-row:not(.is-completed)').count(), 0)
  await shot('35-redesigned-dark-transfers')
  await page.getByRole('button', { name: 'People & access', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit admin', exact: true })).toBeVisible()
  await shot('36-redesigned-dark-people')
  await page.getByRole('button', { name: 'Activity', exact: true }).click()
  await page.getByLabel('Search activity').fill('finished an upload')
  await expect(page.locator('.activity-table tbody tr').first()).toContainText('finished an upload')
  await shot('37-redesigned-dark-activity')
  check('redesigned transfers and activity filters show matching records')

  await page.getByRole('button', { name: 'My files', exact: true }).first().click()
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await shot('38-keyboard-shortcuts')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'List view', exact: true }).click()
  await page.locator('.files-scroll').focus()
  await page.keyboard.press('g')
  await page.keyboard.press('t')
  await expect(page.getByRole('heading', { name: 'Transfers', exact: true })).toBeVisible()
  check('keyboard shortcut help closes with Escape and G T navigates to transfers')

  await page.getByRole('button', { name: 'My files', exact: true }).first().click()
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    for (const label of ['My files', 'Transfers', 'People & access', 'Activity', 'Settings']) {
      await expect(page.getByRole('button', { name: label, exact: true }).first()).toBeVisible()
    }
    await shot(width === 390 ? '39-redesigned-dark-mobile' : '40-redesigned-dark-tablet')
  }
  check('390 px mobile and 768 px tablet retain navigation without page overflow')

  assert.deepEqual(errors, [])
  check('no unhandled browser JavaScript errors')
  await writeFile(join(output, 'browser-redesign-results.json'), JSON.stringify({ status: 'PASS', results, errors, browserVersion: browser.version() }, null, 2))
} catch (error) {
  await shot('failure-redesign').catch(() => {})
  await writeFile(join(output, 'browser-redesign-results.json'), JSON.stringify({ status: 'FAIL', error: error.stack, results, errors }, null, 2))
  throw error
} finally {
  await browser.close()
}
