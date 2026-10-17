import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

for (const format of ['zip', '7z']) for (const cancellation of [false, true]) test(`${format}: ${cancellation ? 'cancellation' : 'progress callback failure'} rejects the operation without crashing the process`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-codec-events-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, 'fake-7zip.cjs')
  await writeFile(binary, '#!/usr/bin/env node\nprocess.stderr.write("25%"); setTimeout(() => {}, 500)\n', { mode: 0o700 })
  const source = `
    import assert from 'node:assert/strict'
    import { Readable } from 'node:stream'
    import { packArchive } from ${JSON.stringify(pathToFileURL(resolve('backend/operations/archive-codecs.ts')).href)}
    const fail = () => { throw ${cancellation ? "'canceled'" : "new Error('Expected progress callback failure')"} }
    const work = { signal: new AbortController().signal, maxBytes: 1048576, maxEntries: 10,
      check() {}, total() {}, tick(_name, _bytes, files) { if (${JSON.stringify(format)} === 'zip' && files) fail() },
      nativeProgress: ${JSON.stringify(format)} === '7z' ? fail : () => {} }
    await assert.rejects(packArchive(${JSON.stringify(format)}, [{ name: 'file.txt', kind: 'file', size: 1,
      modifiedAt: new Date().toISOString(), open: async () => Readable.from(['x']) }],
      ${JSON.stringify(join(root, 'output.' + format))}, ${JSON.stringify(root)}, work), ${cancellation ? '/Archive operation stopped/' : '/Expected progress callback failure/'})
  `
  // An uncaught event exception must fail only this disposable child, never the test runner.
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env: { ...process.env, FB_7ZIP_PATH: binary }, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})
