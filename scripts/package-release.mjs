import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const project = resolve('.')
const output = resolve(process.argv[2] ?? 'release/runtime')
const app = join(output, 'app')
const image = process.argv[3]
const definition = JSON.parse(await readFile('package.json', 'utf8'))
// A new directory prevents old files or local state entering a distribution.
await mkdir(dirname(output), { recursive: true })
await mkdir(output)
await mkdir(app)
if (image) {
  const container = execFileSync('docker', ['create', image], { encoding: 'utf8' }).trim()
  try { execFileSync('docker', ['cp', container + ':/app/dist', app]) }
  finally { execFileSync('docker', ['rm', container], { stdio: 'ignore' }) }
} else {
  await cp('dist', join(app, 'dist'), { recursive: true })
}

// Preserve Node's installed dependency graph, including nested versions and
// accompanying licenses. Never resolve a package from outside this project.
const packages = new Map()
async function locate(name, from) {
  let current = from
  while (true) {
    const candidate = join(current, 'node_modules', name)
    try { await access(join(candidate, 'package.json')); return candidate }
    catch { /* Continue Node's resolution order. */ }
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
  const location = relative(project, source)
  if (!location.startsWith('node_modules/')) throw new Error('Dependency is outside the project: ' + name)
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  packages.set(source, metadata)
  const target = join(app, location)
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, dereference: true, filter: path => !path.endsWith('.node') })
  for (const dependency of Object.keys(metadata.dependencies ?? {})) await include(dependency, source)
  // Native SSH acceleration is optional; omit it for portable AMD64/ARM64 archives.
  for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) if (dependency !== 'cpu-features') await include(dependency, source, true)
  for (const dependency of Object.keys(metadata.peerDependencies ?? {})) await include(dependency, source, true)
}
const dependencies = {}
for (const name of ['fastify', '@fastify/cookie', '@fastify/static', 'dotenv', 'zod', 'tar-stream', 'hash-wasm', '@aws-sdk/client-s3', 'basic-ftp', 'ssh2']) {
  await include(name, project)
  dependencies[name] = packages.get(await locate(name, project)).version
}
await writeFile(join(app, 'package.json'), JSON.stringify({ name: definition.name, private: true, version: definition.version, type: 'module', license: definition.license, dependencies }, null, 2) + '\n')
for (const path of ['LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md', 'licenses']) await cp(path, join(output, path), { recursive: true })
await cp('examples', join(output, 'examples'), { recursive: true })
await mkdir(join(output, 'docs'))
for (const name of ['storage-targets.md', 'network-shares.md']) await cp(join('docs', name), join(output, 'docs', name))
await writeFile(join(output, 'DEPLOYMENT.md'), (await readFile('docs/deployment.md', 'utf8'))
  .replaceAll('(../examples/', '(examples/').replaceAll('(storage-targets.md)', '(docs/storage-targets.md)'))
const server = await readFile(join(app, 'dist/server/server.js'))
let sourceCommit = process.env.FB_BUILD_COMMIT ?? null
if (!sourceCommit) {
  try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { /* Source archives and container builds need not contain Git metadata. */ }
}
const metadata = {
  name: definition.name, version: definition.version,
  sourceCommit,
  serverSha256: createHash('sha256').update(server).digest('hex'),
  runtimeRequirement: 'Node.js >=24 on a supported platform',
  ...(image ? { image } : {}),
  packages: [...packages.entries()].map(([path, pkg]) => ({ path: relative(project, path), name: pkg.name, version: pkg.version, license: pkg.license ?? null })),
}
await writeFile(join(output, 'release.json'), JSON.stringify(metadata, null, 2) + '\n')
console.log(JSON.stringify({ output, packages: packages.size, serverSha256: metadata.serverSha256 }, null, 2))
