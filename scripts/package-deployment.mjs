import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const output = resolve(process.argv[2])
const image = process.argv[3] ?? 'filebrowser-deploy-verify-app'
const project = resolve('.')
const app = join(output, 'app')
await mkdir(app, { recursive: true })
const container = execFileSync('docker', ['create', image], { encoding: 'utf8' }).trim()
try {
  execFileSync('docker', ['cp', container + ':/app/dist', app])
} finally { execFileSync('docker', ['rm', container]) }

// Copy the exact installed dependency graph, including nested packages. No npm
// download or install is needed on the deployment host, and unused Prisma/UI
// packages do not need to accompany the production server.
const packages = new Map()
async function locate(name, from) {
  let current = from
  while (true) {
    const candidate = join(current, 'node_modules', name)
    try { await access(join(candidate, 'package.json')); return candidate } catch { /* Try the next Node resolution directory. */ }
    const above = dirname(current)
    if (above === current) return null
    current = above
  }
}
async function include(name, from, optional = false) {
  const source = await locate(name, from)
  if (!source) {
    if (optional) return
    throw new Error('Missing production dependency: ' + name)
  }
  if (packages.has(source)) return
  const localPath = relative(project, source)
  if (localPath.startsWith('../') || !localPath.startsWith('node_modules/')) throw new Error('Dependency is outside the project: ' + name)
  const definition = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  packages.set(source, definition)
  const target = join(app, localPath)
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, dereference: true })
  for (const dependency of Object.keys(definition.dependencies ?? {})) await include(dependency, source)
  for (const dependency of Object.keys(definition.optionalDependencies ?? {})) await include(dependency, source, true)
  for (const dependency of Object.keys(definition.peerDependencies ?? {})) await include(dependency, source, true)
}
const dependencies = {}
for (const name of ['fastify', '@fastify/cookie', '@fastify/static', 'dotenv', 'zod']) {
  await include(name, project)
  const source = await locate(name, project)
  dependencies[name] = packages.get(source).version
}
await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'filebrowser2-production', private: true, version: '0.1.0', type: 'module', dependencies }, null, 2) + '\n')
await cp('deployment/upstart/filebrowser2.conf', join(output, 'filebrowser2.conf'))
const server = await readFile(join(app, 'dist/server/server.js'))
const metadata = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceChanges: execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean),
  image,
  serverSha256: createHash('sha256').update(server).digest('hex'),
  runtime: 'Node.js 24.21.0 with private Debian 12 libraries',
  packages: [...packages.entries()].map(([path, definition]) => ({ path: relative(project, path), name: definition.name, version: definition.version })),
}
await writeFile(join(output, 'deployment.json'), JSON.stringify(metadata, null, 2) + '\n')
console.log(JSON.stringify({ output, packages: packages.size, serverSha256: metadata.serverSha256 }, null, 2))
