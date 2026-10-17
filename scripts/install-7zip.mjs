import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Official upstream binaries, pinned independently of distribution package age.
const builds = {
  amd64: ['x64', 'fc0327ba27e89bd086cf426dff17d77de582953cdbbc10a6576540a06853ffcd'],
  arm64: ['arm64', '5b0ac3aa91c1e3499f011d6af69d7f6b4de3ef2f011d9e2ff44c58ebd04aa388'],
}
const architecture = process.argv[3] ?? ({ x64: 'amd64', arm64: 'arm64' })[process.arch]
const build = builds[architecture]
if (!build) throw new Error('7-Zip runtime supports Linux amd64 and arm64')
const destination = resolve(process.argv[2] ?? '.filebrowser-tools/7zip')
const temporary = await mkdtemp(join(tmpdir(), 'filebrowser-7zip-'))
try {
  const response = await fetch(`https://www.7-zip.org/a/7z2604-linux-${build[0]}.tar.xz`)
  if (!response.ok) throw new Error('Cannot download 7-Zip: ' + response.status)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== build[1]) throw new Error('7-Zip download checksum mismatch')
  const archive = join(temporary, '7zip.tar.xz'); await writeFile(archive, bytes)
  await mkdir(destination, { recursive: true })
  execFileSync('tar', ['-xJf', archive, '-C', destination])
  // Keep upstream License.txt and the complete bundled documentation with 7zz.
} finally { await rm(temporary, { recursive: true, force: true }) }
