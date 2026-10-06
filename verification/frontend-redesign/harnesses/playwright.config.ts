import { defineConfig } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.env.FB_E2E_ROOT ?? mkdtempSync(join(tmpdir(), 'filebrowser-e2e-'))
process.env.FB_E2E_ROOT = root

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:3217',
    viewport: { width: 1440, height: 980 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      ...(process.env.FB_CHROMIUM_PATH ? { executablePath: process.env.FB_CHROMIUM_PATH } : {}),
      args: ['--no-sandbox'],
    },
  },
  webServer: {
    command: 'node --import tsx tests/fixtures/e2e-server.js',
    url: 'http://127.0.0.1:3217/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: { FB_E2E_ROOT: root },
  },
})
