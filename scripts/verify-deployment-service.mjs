import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const base = '/root/filebrowser2'
const url = 'http://127.0.0.1:7288'
const checks = []
const check = name => { checks.push({ name, status: 'PASS' }); console.log('PASS ' + name) }
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim()
function pid() {
  const status = command('/sbin/status', ['filebrowser2'])
  const match = /^filebrowser2 start\/running, process (\d+)$/.exec(status)
  assert.ok(match, status)
  return Number(match[1])
}
async function healthy() {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(url + '/health')).ok) return } catch { /* Wait for respawn. */ }
    await delay(100)
  }
  throw new Error('Production service did not become healthy')
}
async function fresh() {
  const bootstrap = await (await fetch(url + '/api/bootstrap')).json()
  assert.equal(bootstrap.needsSetup, true)
  assert.equal(bootstrap.user, null)
  assert.equal(bootstrap.upload.chunkSize, 104857600)
  assert.equal((await fetch(url + '/api/files')).status, 401)
  return bootstrap
}

try {
  await healthy()
  const initialPid = pid()
  assert.match(await readFile('/proc/' + initialPid + '/status', 'utf8'), /^Uid:\s+0\s+0\s+0\s+0$/m)
  const listeners = command('ss', ['-lntp']).split('\n').filter(line => /:7288\s/.test(line))
  assert.equal(listeners.length, 1)
  assert.match(listeners[0], /127\.0\.0\.1:7288\s/)
  assert.ok(listeners[0].includes('pid=' + initialPid + ',') || listeners[0].includes(',' + initialPid + ','), listeners[0])
  await fresh()
  const state = base + '/.filebrowser-state'
  assert.equal((await lstat(state)).mode & 0o777, 0o700)
  assert.equal((await lstat(state + '/filebrowser.sqlite')).mode & 0o777, 0o600)
  const db = new DatabaseSync(state + '/filebrowser.sqlite', { readOnly: true })
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0) } finally { db.close() }
  check('loopback-only listener, root process, private state permissions, default 100 MiB chunks and zero production accounts')

  const html = await (await fetch(url + '/')).text()
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1])
  assert.ok(assets.length >= 2)
  for (const asset of assets) assert.equal((await fetch(url + asset)).status, 200)
  check('production frontend assets and first-run setup are served')

  process.kill(initialPid, 'SIGKILL')
  await delay(250)
  await healthy()
  const respawnPid = pid()
  assert.notEqual(respawnPid, initialPid)
  await fresh()
  check('Upstart automatically respawns after SIGKILL and preserves first-run setup')

  command('/sbin/restart', ['filebrowser2'])
  await healthy()
  const restartPid = pid()
  assert.notEqual(restartPid, respawnPid)
  const bootstrap = await fresh()
  check('explicit service restart succeeds without creating an administrator account')

  const systemNode = command('/usr/local/bin/node', ['--version'])
  assert.equal(systemNode, 'v16.17.1')
  const existingCommands = await Promise.all([15520, 17867].map(async id => (await readFile('/proc/' + id + '/cmdline', 'utf8')).replaceAll('\0', ' ')))
  assert.ok(existingCommands[0].includes('/root/command-panel/server/index.js'))
  assert.ok(existingCommands[1].includes('/root/icdesign-scripts/tools/tcp-port-kill-server.js'))
  assert.deepEqual(await readdir('/.filebrowser-uploads'), [])
  assert.deepEqual((await readdir(base)).filter(name => name.startsWith('deployment-smoke-') || name.startsWith('.filebrowser-smoke-')), [])
  assert.deepEqual((await readdir('/mnt/sda3')).filter(name => name.startsWith('filebrowser2-smoke-')), [])
  check('existing system Node and PM2 applications remain running, and disposable upload fixtures are removed')

  const serverSha256 = createHash('sha256').update(await readFile(base + '/app/dist/server/server.js')).digest('hex')
  await writeFile(base + '/service-verification.json', JSON.stringify({ status: 'PASS', checks, initialPid, respawnPid, restartPid, listeners, bootstrap, uid: process.getuid(), privateNode: process.version, systemNode, serverSha256 }, null, 2) + '\n')
} catch (error) {
  await writeFile(base + '/service-verification.json', JSON.stringify({ status: 'FAIL', checks, error: error.stack }, null, 2) + '\n')
  throw error
}
