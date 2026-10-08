import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const project = fileURLToPath(new URL('../', import.meta.url))
const execute = promisify(execFile)

test('portable runtime boots without the source tree and serves bundled license notices', { timeout: 60_000 }, async t => {
  try { await access(join(project, 'dist/server/server.js')) }
  catch { t.skip('Build the production app before checking runtime packaging'); return }
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-runtime-release-'))
  const output = join(root, 'runtime')
  let child, closed
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed }
    await rm(root, { recursive: true, force: true })
  })
  const packaged = await execute(process.execPath, ['scripts/package-release.mjs', output], { cwd: project })
  assert.ok(JSON.parse(packaged.stdout).packages > 0)
  assert.equal((await lstat(join(output, 'app/node_modules'))).isSymbolicLink(), false)
  assert.deepEqual((await readdir(output)).sort(), ['DEPLOYMENT.md', 'LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md', 'app', 'docs', 'examples', 'licenses', 'release.json'])
  for (const name of ['DEPLOYMENT.md', 'docs/storage-targets.md', 'docs/network-shares.md']) {
    const document = join(output, name)
    for (const match of (await readFile(document, 'utf8')).matchAll(/\]\(([^)]+)\)/g)) {
      if (!match[1].startsWith('https://')) await access(resolve(dirname(document), match[1]))
    }
  }
  assert.equal(await readFile(join(output, 'licenses/inter/OFL.txt'), 'utf8'), await readFile(join(project, 'licenses/inter/OFL.txt'), 'utf8'))
  await assert.rejects(execute(process.execPath, ['scripts/package-release.mjs', output], { cwd: project }), /EEXIST/)
  child = spawn(process.execPath, ['app/dist/server/server.js'], {
    cwd: output,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', FB_STATE_DIR: join(root, 'state'), FB_LOG_LEVEL: 'warn', FB_BUILD_COMMIT: 'release-fixture' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  closed = once(child, 'close')
  let logs = ''
  child.stdout.on('data', bytes => { logs += bytes })
  child.stderr.on('data', bytes => { logs += bytes })
  for (let i = 0; i < 150 && !/^Server listening at /m.test(logs); i++) await delay(50)
  const address = /^Server listening at (http:\/\/\S+)$/m.exec(logs)?.[1]
  assert.ok(address, logs)
  assert.deepEqual(await (await fetch(address + '/health')).json(), { status: 'ok', commit: 'release-fixture' })
  assert.equal((await (await fetch(address + '/api/bootstrap')).json()).needsSetup, true)
  assert.equal((await fetch(address + `/api/targets/00000000-0000-4000-8000-000000000000/files`)).status, 401)
  for (const path of ['licenses/inter/OFL.txt', 'licenses/jetbrains-mono/OFL.txt', 'licenses/frontend/react.LICENSE.txt', 'licenses/frontend/hash-wasm.LICENSE.txt']) {
    const response = await fetch(address + '/' + path)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), await readFile(join(project, path), 'utf8'))
  }
  const notices = await (await fetch(address + '/licenses/THIRD_PARTY_NOTICES.md')).text()
  for (const match of notices.matchAll(/\]\(([^)]+)\)/g)) {
    if (match[1].startsWith('https://')) continue
    assert.equal((await fetch(new URL(match[1], address + '/licenses/THIRD_PARTY_NOTICES.md'))).status, 200, match[1])
  }
  const html = await (await fetch(address)).text()
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)) assert.equal((await fetch(address + match[1])).status, 200)
})

test('source archives omit Git history and refuse unreviewed or generated files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-source-release-'))
  const fixture = join(root, 'source')
  await mkdir(fixture)
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'filebrowser2', version: '0.1.0', license: 'MIT' }))
  await writeFile(join(fixture, 'README.md'), 'Public fixture\n')
  const git = args => execute('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: fixture })
  await git(['init', '-q'])
  await git(['add', '.'])
  await git(['commit', '-qm', 'Public fixture'])
  const packageSource = output => execute(process.execPath, [join(project, 'scripts/package-source.mjs'), output], { cwd: fixture })
  const result = JSON.parse((await packageSource(join(root, 'artifacts'))).stdout)
  const entries = (await execute('tar', ['-tzf', result.archive])).stdout.trim().split('\n')
  assert.deepEqual(entries, ['filebrowser2-0.1.0/', 'filebrowser2-0.1.0/README.md', 'filebrowser2-0.1.0/package.json'])
  assert.match(await readFile(result.archive + '.sha256', 'utf8'), /^[a-f0-9]{64} {2}filebrowser2-0\.1\.0-source\.tar\.gz\n$/)
  await writeFile(join(fixture, 'local.log'), 'Disposable local output\n')
  await assert.rejects(packageSource(join(root, 'unreviewed')), /working tree must be clean/)
  await rm(join(fixture, 'local.log'))
  for (const file of ['local.log', 'accounts.sqlite-journal', 'account.db', 'private-history.bundle', 'trace.tar.gz', 'trace.zip']) {
    await writeFile(join(fixture, file), 'Disposable generated fixture\n')
    await git(['add', file])
    await git(['commit', '-qm', 'Generated fixture'])
    await assert.rejects(packageSource(join(root, 'generated')), /must not enter a source release/, file)
    await git(['rm', file])
    await git(['commit', '-qm', 'Remove generated fixture'])
  }
})
