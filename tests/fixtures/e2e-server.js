import { resolve, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { createApp } from '../../backend/app.ts'

const root = process.env.FB_E2E_ROOT
if (!root) throw new Error('FB_E2E_ROOT is required')
const app = await createApp({ frontendRoot: resolve('dist/client'), setupLocalPath: join(root,'files'), setupLocalReadOnly: true, stateDirectory: join(root,'state') })
await app.listen({ host:'127.0.0.1',port:3217 })
process.on('SIGTERM',()=>{void app.close().then(()=>rm(root,{recursive:true,force:true}))})
