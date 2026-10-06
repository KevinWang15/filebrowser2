# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: filebrowser.spec.ts >> setup, file operations, worker hashing, reload resume, scoped users, and mobile layout
- Location: tests/e2e/filebrowser.spec.ts:6:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('button', { name: 'large-source.bin', exact: true })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('button', { name: 'large-source.bin', exact: true }) with timeout 5000ms
  - waiting for getByRole('button', { name: 'large-source.bin', exact: true })

```

```yaml
- complementary:
  - text: Filebrowser. F
  - strong: Filebrowser
  - text: Private workspace WORKSPACE
  - navigation:
    - button "My files"
    - button "Transfers"
  - text: ADMINISTRATION
  - navigation:
    - button "People & access"
    - button "Activity"
    - button "Settings"
  - strong: Local storage
  - paragraph:
    - strong: 100.4 GiB
    - text: available
  - text: of 450.1 GiB on this volume Your space. Your control.
- banner:
  - text: Workspace
  - strong: My files
  - textbox "Search files":
    - /placeholder: Search in this folder…
  - text: ⌕ AD
  - strong: admin
  - text: Administrator
  - button "Sign out"
- main:
  - text: YOUR WORKSPACE, ORGANIZED
  - heading "All files." [level=1]
  - paragraph: Everything you need, right where you left it.
  - button "New folder"
  - button "Upload files"
  - text: Local storage Private & secure 1 item 0 B in this folder
  - button "My files"
  - button "Refresh files"
  - button "List view"
  - button "Grid view"
  - table:
    - rowgroup:
      - row "Select all files Name Last modified File size Type":
        - columnheader "Select all files":
          - checkbox "Select all files"
        - columnheader "Name":
          - button "Name"
        - columnheader "Last modified":
          - button "Last modified"
        - columnheader "File size":
          - button "File size"
        - columnheader "Type"
        - columnheader
    - rowgroup:
      - row "Select Team documents Team documents Oct 6, 2026 — Folder Details for Team documents":
        - cell "Select Team documents":
          - checkbox "Select Team documents"
        - cell "Team documents":
          - button "Team documents"
        - cell "Oct 6, 2026"
        - cell "—"
        - cell "Folder"
        - cell "Details for Team documents":
          - button "Details for Team documents"
  - text: 1 folders, 0 files Only people you give access can see these files
  - strong: Big files? You’re in the right place.
  - text: Resumable uploads keep your progress safe, even when your connection doesn’t.
  - button "Start a transfer"
- contentinfo: Storage connected Filebrowser / A place for everything. Private workspace
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test'
  2   | import { createHash } from 'node:crypto'
  3   | import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
  4   | import { join } from 'node:path'
  5   | 
  6   | test('setup, file operations, worker hashing, reload resume, scoped users, and mobile layout', async ({ page, context }, testInfo) => {
  7   |   const pageErrors: string[] = []
  8   |   page.on('pageerror', error => pageErrors.push(error.message))
  9   |   await page.goto('/')
  10  |   await expect(page.getByRole('heading', { name: 'Make yourself at home.' })).toBeVisible()
  11  |   await page.screenshot({ path: testInfo.outputPath('setup.png'), fullPage: true })
  12  |   await page.getByLabel('Workspace name').fill('Filebrowser')
  13  |   await page.getByRole('button', { name: 'Continue', exact: true }).click()
  14  |   await page.getByLabel('Username', { exact: true }).fill('admin')
  15  |   await page.getByLabel('Password', { exact: true }).fill('browser-test-password-123')
  16  |   await page.getByLabel('Confirm password').fill('browser-test-password-123')
  17  |   await page.getByRole('button', { name: 'Continue', exact: true }).click()
  18  |   await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  19  |   await expect(page.getByRole('heading', { name: 'All files.' })).toBeVisible()
  20  |   await page.getByRole('button', { name: 'New folder', exact: true }).click()
  21  |   await page.getByLabel('Folder name').fill('Team documents')
  22  |   await page.getByRole('button', { name: 'Create folder', exact: true }).click()
  23  |   await expect(page.getByRole('button', { name: 'Team documents', exact: true })).toBeVisible()
  24  |   await page.getByRole('button', { name: 'Team documents', exact: true }).click()
  25  |   await page.getByRole('button', { name: 'Upload files', exact: true }).click()
  26  |   await page.getByLabel('Connections per chunk').selectOption('4')
  27  |   const content = Buffer.from('A file uploaded, hashed, and verified through the real browser.\n'.repeat(500))
  28  |   await page.locator('input[type=file][multiple]').setInputFiles({ name: 'project-notes.md', mimeType: 'text/markdown', buffer: content })
  29  |   await expect(page.locator('.transfer-row').filter({ hasText: 'project-notes.md' }).getByText('Complete', { exact: true })).toBeVisible({ timeout: 30_000 })
  30  |   await page.getByRole('button', { name: 'My files', exact: true }).first().click()
  31  |   await expect(page.getByRole('button', { name: 'project-notes.md', exact: true })).toBeVisible()
  32  |   await page.getByRole('button', { name: 'project-notes.md', exact: true }).click()
  33  |   await page.getByRole('button', { name: 'Preview', exact: true }).click()
  34  |   await expect(page.locator('.text-preview')).toContainText('verified through the real browser')
  35  |   const downloadPromise = page.waitForEvent('download')
  36  |   await page.getByRole('button', { name: 'Download', exact: true }).click()
  37  |   const download = await downloadPromise
  38  |   const downloadedPath = await download.path()
  39  |   expect(await readFile(downloadedPath!)).toEqual(content)
  40  |   await page.getByRole('button', { name: 'Close dialog' }).click()
  41  |   await page.getByRole('button', { name: 'Grid view' }).click()
  42  |   await page.screenshot({ path: testInfo.outputPath('files-grid.png'), fullPage: true })
  43  |   await page.getByRole('button', { name: 'List view' }).click()
  44  |   await page.screenshot({ path: testInfo.outputPath('files-list.png'), fullPage: true })
  45  | 
  46  |   const testRoot = process.env.FB_E2E_ROOT!
  47  |   await mkdir(join(testRoot, 'source'), { recursive: true })
  48  |   const largePath = join(testRoot, 'source', 'large-source.bin')
  49  |   const chunkSize = 100 * 1024 * 1024
  50  |   const file = await open(largePath, 'w')
  51  |   await file.truncate(chunkSize + 1024 * 1024)
  52  |   await file.close()
  53  |   let interrupted = false
  54  |   await page.route('**/api/uploads/*/chunks/1/start', async route => {
  55  |     interrupted = true
  56  |     await route.abort('failed')
  57  |   })
  58  |   await page.getByRole('button', { name: 'Upload files', exact: true }).click()
  59  |   await page.locator('input[type=file][multiple]').setInputFiles(largePath)
  60  |   await expect.poll(() => interrupted, { timeout: 45_000 }).toBe(true)
  61  |   await expect(page.locator('.transfer-row').filter({ hasText: 'large-source.bin' })).toContainText('100 MiB verified')
  62  |   await page.getByRole('button', { name: 'My files', exact: true }).first().click()
  63  |   const pendingRow = page.getByRole('row').filter({ hasText: 'large-source.bin.uploading' })
  64  |   await expect(pendingRow.getByText('Uploading', { exact: true })).toBeVisible()
  65  |   await expect(page.getByLabel('Select large-source.bin.uploading')).toBeDisabled()
  66  |   await page.getByRole('button', { name: 'large-source.bin.uploading', exact: true }).click()
  67  |   await expect(page.getByText('This file is still uploading.', { exact: false })).toBeVisible()
  68  |   await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0)
  69  |   await expect(page.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0)
  70  |   await page.screenshot({ path: testInfo.outputPath('uploading-details.png'), fullPage: true })
  71  |   await page.getByRole('button', { name: 'Close dialog' }).click()
  72  |   await page.screenshot({ path: testInfo.outputPath('uploading-file.png'), fullPage: true })
  73  |   await page.reload()
  74  |   await page.unroute('**/api/uploads/*/chunks/1/start')
  75  |   await page.getByRole('button', { name: 'Transfers', exact: false }).first().click()
  76  |   const transfer = page.locator('.transfer-row').filter({ hasText: 'large-source.bin' })
  77  |   await expect(transfer).toContainText('Ready to resume')
  78  |   await transfer.getByRole('button', { name: 'Select file' }).click()
  79  |   await page.locator('input[type=file]:not([multiple])').setInputFiles(largePath)
  80  |   await expect(transfer.getByText('Complete', { exact: true })).toBeVisible({ timeout: 45_000 })
  81  |   const result = await readFile(join(testRoot, 'files', 'Team documents', 'large-source.bin'))
  82  |   expect(result.length).toBe(chunkSize + 1024 * 1024)
  83  |   expect(createHash('sha256').update(result).digest('hex')).toBe(createHash('sha256').update(await readFile(largePath)).digest('hex'))
  84  |   await page.screenshot({ path: testInfo.outputPath('transfers.png'), fullPage: true })
  85  |   await page.getByRole('button', { name: 'My files', exact: true }).first().click()
> 86  |   await expect(page.getByRole('button', { name: 'large-source.bin', exact: true })).toBeVisible()
      |                                                                                     ^ Error: expect(locator).toBeVisible() failed
  87  |   await expect(page.getByRole('button', { name: 'large-source.bin.uploading', exact: true })).toHaveCount(0)
  88  | 
  89  |   await page.getByRole('button', { name: 'People & access' }).click()
  90  |   await page.getByRole('button', { name: 'Add a person' }).click()
  91  |   await page.getByLabel('Username', { exact: true }).fill('alex')
  92  |   await page.getByLabel('Password', { exact: true }).fill('member-test-password-123')
  93  |   await page.getByLabel('Home folder').fill('/Team documents')
  94  |   await page.getByRole('button', { name: 'Read only', exact: true }).click()
  95  |   await page.getByRole('button', { name: 'Add person', exact: true }).click()
  96  |   await expect(page.getByRole('row').filter({ hasText: 'alex' })).toBeVisible()
  97  |   await page.screenshot({ path: testInfo.outputPath('people.png'), fullPage: true })
  98  |   await page.getByRole('button', { name: 'Edit alex' }).click()
  99  |   await expect(page.getByLabel('Upload', { exact: false })).not.toBeChecked()
  100 |   await page.getByRole('button', { name: 'Close dialog' }).click()
  101 |   const member = await context.browser()!.newContext()
  102 |   const memberPage = await member.newPage()
  103 |   await memberPage.goto('http://127.0.0.1:3217/')
  104 |   await memberPage.getByLabel('Username', { exact: true }).fill('alex')
  105 |   await memberPage.getByLabel('Password', { exact: true }).fill('member-test-password-123')
  106 |   await memberPage.getByRole('button', { name: 'Sign in', exact: true }).click()
  107 |   await expect(memberPage.getByRole('button', { name: 'project-notes.md', exact: true })).toBeVisible()
  108 |   await expect(memberPage.getByRole('button', { name: 'Upload files', exact: true })).toHaveCount(0)
  109 |   await expect(memberPage.getByRole('button', { name: 'People & access' })).toHaveCount(0)
  110 |   await memberPage.getByRole('button', { name: 'Account settings', exact: true }).click()
  111 |   await page.getByRole('button', { name: 'Edit alex' }).click()
  112 |   await page.getByLabel('Disable this account').check()
  113 |   await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  114 |   await memberPage.getByRole('button', { name: 'My files', exact: true }).first().click()
  115 |   await expect(memberPage.getByRole('heading', { name: 'Good to see you again.' })).toBeVisible()
  116 |   await member.close()
  117 |   await page.getByRole('button', { name: 'Activity', exact: true }).click()
  118 |   await expect(page.locator('.activity-list')).toContainText('finished an upload')
  119 |   await page.getByRole('button', { name: 'Settings', exact: true }).click()
  120 |   await expect(page.getByText('100 MiB', { exact: true })).toBeVisible()
  121 |   await page.getByRole('button', { name: 'My files', exact: true }).first().click()
  122 |   await page.setViewportSize({ width: 390, height: 844 })
  123 |   await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true })
  124 |   expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  125 |   expect(pageErrors).toEqual([])
  126 |   await writeFile(testInfo.outputPath('validation.txt'), 'Setup, scoped users, text preview, byte-identical download, SHA-256 worker, 101 MiB upload, and reload resume verified.\n')
  127 | })
  128 | 
```