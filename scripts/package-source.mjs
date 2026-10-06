import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const output = resolve(process.argv[2] ?? 'release')
const definition = JSON.parse(await readFile('package.json', 'utf8'))
if (!/^[a-z0-9._-]+$/.test(definition.name) || !/^[0-9A-Za-z.+-]+$/.test(definition.version)) throw new Error('Invalid package name or version')
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim()) {
  throw new Error('Commit the reviewed source before packaging; the working tree must be clean')
}
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
for (const path of paths) {
  if (/^(?:deployment|verification|data|node_modules|dist|release|test-results|playwright-report)\//.test(path) || /^backend\/generated\//.test(path) || /(?:^|\/)\.filebrowser[^/]*(?:\/|$)/.test(path) || (/(?:^|\/)\.env(?:\.|$)/.test(path) && path !== '.env.example') || /\.(?:sqlite(?:-wal|-shm)?|log|zip)$/.test(path)) {
    throw new Error('Local or generated file must not enter a source release: ' + path)
  }
}
await mkdir(output, { recursive: true })
const name = `${definition.name}-${definition.version}`
const archive = join(output, name + '-source.tar.gz')
execFileSync('git', ['archive', '--format=tar.gz', '--prefix=' + name + '/', '--output=' + archive, 'HEAD'])
const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
await writeFile(archive + '.sha256', digest + '  ' + name + '-source.tar.gz\n')
console.log(JSON.stringify({ archive, sha256: digest }, null, 2))
