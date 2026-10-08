import { createApp } from '../../backend/app.ts'

const crash = () => process.kill(process.pid, 'SIGKILL')
const app = await createApp({
  stateDirectory: process.env.FB_STATE_DIR,
  uploadFaults: {
    ...(process.env.FB_CRASH_AT === 'append' ? { afterAppend: crash } : {}),
    ...(process.env.FB_CRASH_AT === 'publish' ? { afterPublish: crash } : {}),
    ...(process.env.FB_CRASH_AT === 'publish-link' ? { afterPublishLink: crash } : {}),
    ...(process.env.FB_CRASH_AT === 'cancel' ? { afterCancelCleanup: crash } : {}),
  },
})
const address = await app.listen({ host: '127.0.0.1', port: 0 })
console.log('READY ' + address)
process.on('SIGTERM', () => { void app.close() })
