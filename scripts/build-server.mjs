import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
await rm(new URL('../dist/server/', import.meta.url), { recursive: true, force: true })
await build({
  absWorkingDir: root,
  entryPoints: ['backend/server.ts'],
  outfile: 'dist/server/server.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  tsconfig: 'tsconfig.node.json',
  sourcemap: true,
  logLevel: 'info',
})
await build({
  absWorkingDir: root,
  entryPoints: ['backend/shares/samba-agent.ts'],
  outfile: 'dist/server/samba-agent.js',
  bundle: true,
  platform: 'node', target: 'node24', format: 'esm',
  tsconfig: 'tsconfig.node.json', logLevel: 'info',
})
