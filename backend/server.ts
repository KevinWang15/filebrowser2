import 'dotenv/config'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from './app'
import { serverStorage } from './config'

const port = Number(process.env.PORT ?? 3000)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be an integer between 0 and 65535')
}

// Relative to dist/server/server.js, independent of the process working directory.
const frontendRoot = fileURLToPath(new URL('../client/', import.meta.url))
const app = await createApp({
  logger: true,
  ...serverStorage(),
  ...(existsSync(frontendRoot) ? { frontendRoot } : {}),
})
const address = await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' })
console.log(`Server listening at ${address}`)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    const deadline = setTimeout(() => process.exit(1), 10_000).unref()
    void app.close().catch(error => {
      app.log.error(error)
      process.exitCode = 1
    }).finally(() => clearTimeout(deadline))
  })
}
