import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chown, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { agentStatusSchema, controlSchema, SHARE_LEASE_MS, type ControlShare, type ShareAgentStatus, type ShareControl } from './control'

const execute = promisify(execFile)
const controlDirectory = resolve(process.env.FB_SMB_CONTROL_DIR ?? '/control')
const allowedRoots = (JSON.parse(process.env.FB_SMB_ALLOWED_ROOTS ?? '["/files"]') as string[]).map(root => resolve(root))
if (!allowedRoots.length || allowedRoots.some(root => root === '/')) throw new Error('Configure explicit SMB mount roots')
const stateDirectory = resolve(process.env.FB_SMB_STATE_DIR ?? '/samba-state')
const port = Number(process.env.FB_SMB_PORT ?? 445)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMB port')

async function readControl(): Promise<ShareControl> {
  const handle = await open(join(controlDirectory, 'desired.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o077)) throw new Error('Invalid control file')
    const control = controlSchema.parse(JSON.parse(await handle.readFile('utf8')))
    if (control.expiresAt <= Date.now() || control.expiresAt > Date.now() + SHARE_LEASE_MS + 1_000) throw new Error('Expired control lease')
    return control
  } finally { await handle.close() }
}

async function atomicFile(path: string, value: string, owner?: { uid: number; gid: number }) {
  const temporary = path + '.' + randomUUID()
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(value); await handle.sync(); if (owner) await chown(temporary, owner.uid, owner.gid) }
    finally { await handle.close() }
    await rename(temporary, path)
  } catch (error) { await unlink(temporary).catch(() => {}); throw error }
}

async function identity(storageRoot: string, path: string) {
  if (!allowedRoots.some(root => storageRoot === root || storageRoot.startsWith(root + '/'))) throw new Error('Export root is outside mounted directories')
  let current = storageRoot
  if ((await lstat(current)).isSymbolicLink()) throw new Error('Storage root is a symlink')
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid directory')
  }
  const info = await lstat(current, { bigint: true })
  if (!info.isDirectory()) throw new Error('Invalid directory')
  return { dev: info.dev.toString(), ino: info.ino.toString() }
}
const equalIdentity = (a: { dev: string; ino: string }, b: { dev: string; ino: string }) => a.dev === b.dev && a.ino === b.ino

async function account(share: ControlShare) {
  let previous: string | null = null
  try { previous = (await execute('getent', ['passwd', share.username], { timeout: 5_000 })).stdout }
  catch (error) { if ((error as { code?: number }).code !== 2) throw error }
  if (previous) {
    if (Number(previous.split(':')[2]) !== share.uid) throw new Error('Managed SMB account collision')
  } else {
    await execute('useradd', ['--non-unique', '--no-create-home', '--no-user-group', '--gid', '65534', '--uid', String(share.uid), '--shell', '/usr/sbin/nologin', share.username], { timeout: 5_000 })
  }
}

async function filesystemAccount(access: ShareControl['access']) {
  async function group(gid: number) {
    try { return (await execute('getent', ['group', String(gid)], { timeout: 5_000 })).stdout.split(':')[0] }
    catch (error) { if ((error as { code?: number }).code !== 2) throw error }
    const name = 'fb_g' + gid
    await execute('groupadd', ['--gid', String(gid), name], { timeout: 5_000 })
    return name
  }
  const primary = await group(access.gid)
  let name = ''
  try { name = (await execute('getent', ['passwd', String(access.uid)], { timeout: 5_000 })).stdout.split(':')[0] }
  catch (error) { if ((error as { code?: number }).code !== 2) throw error }
  if (!name) {
    name = 'fb_fs' + access.uid
    await execute('useradd', ['--no-create-home', '--no-user-group', '--uid', String(access.uid), '--gid', primary, '--shell', '/usr/sbin/nologin', name], { timeout: 5_000 })
  }
  if (access.uid !== 0) {
    const groups = await Promise.all([...new Set(access.groups)].map(group))
    await execute('usermod', ['--gid', primary, '--groups', groups.join(','), name], { timeout: 5_000 })
  }
  return { name, group: primary }
}

function configuration(shares: ControlShare[], filesystem: { name: string; group: string }) {
  return [
    '[global]', 'server role = standalone server', 'security = user', 'workgroup = WORKGROUP',
    'server min protocol = SMB3', 'server signing = mandatory', 'smb encrypt = required',
    'ntlm auth = ntlmv2-only', 'map to guest = Never', 'restrict anonymous = 2',
    'disable netbios = yes', `smb ports = ${port}`, 'load printers = no', 'disable spoolss = yes', 'access based share enum = yes',
    'printing = bsd', 'printcap name = /dev/null', 'usershare max shares = 0', 'unix extensions = no',
    `passdb backend = smbpasswd:${join(stateDirectory, 'smbpasswd')}`,
    `private dir = ${join(stateDirectory, 'private')}`, `state directory = ${join(stateDirectory, 'state')}`,
    `lock directory = ${join(stateDirectory, 'run')}`, `pid directory = ${join(stateDirectory, 'run')}`,
    `cache directory = ${join(stateDirectory, 'cache')}`, `ncalrpc dir = ${join(stateDirectory, 'ncalrpc')}`,
    'log file = /dev/null', 'logging = file', 'log level = 0',
    ...shares.flatMap(share => [
      '', `[${share.name}]`, `path = ${share.storage.path}${share.path === '/' ? '' : share.path}`,
      `valid users = ${share.username}`, 'guest ok = no', 'read only = yes', 'browseable = yes',
      `force user = ${filesystem.name}`, `force group = ${filesystem.group}`, 'follow symlinks = no', 'wide links = no', 'case sensitive = yes',
      'veto files = /.filebrowser-*/*.uploading/', 'delete veto files = no',
    ]), '',
  ].join('\n')
}

let server: ChildProcess | undefined
let serverRevision = ''
let leaseTimer: ReturnType<typeof setTimeout> | undefined
let effective = ''
let stopping = false
let lastStatus = ''
async function stopServer() {
  if (leaseTimer) clearTimeout(leaseTimer)
  leaseTimer = undefined
  const child = server
  server = undefined
  serverRevision = ''
  effective = ''
  if (!child?.pid) return
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()))
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already stopped. */ }
  await Promise.race([exited, delay(1_000)])
  // Terminate any client workers as well, including workers whose parent exited first.
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* Process group is empty. */ }
  await exited
}

function renewLease(control: ShareControl) {
  if (leaseTimer) clearTimeout(leaseTimer)
  const child = server
  if (!child) return
  // This timer can close clients even while directory checks or commands wait.
  leaseTimer = setTimeout(() => { if (server === child) void stopServer().catch(() => {}) }, Math.max(0, control.expiresAt - Date.now()))
}

async function monitorLease() {
  while (!stopping) {
    try {
      const control = await readControl()
      if (server && control.revision !== serverRevision) await stopServer()
      else if (server) renewLease(control)
    } catch { await stopServer() }
    await delay(250)
  }
}

async function status(value: Omit<ShareAgentStatus, 'version' | 'checkedAt'>) {
  const owner = await lstat(controlDirectory)
  await atomicFile(join(controlDirectory, 'status.json'), JSON.stringify({ version: 2, checkedAt: Date.now(), ...value }), owner)
  const summary = JSON.stringify({ ready: value.ready, error: value.error, shares: value.active.length, blocked: value.failed.length })
  if (summary !== lastStatus) { console.log(summary); lastStatus = summary }
}

async function reconcile() {
  let control: ShareControl
  try { control = await readControl() }
  catch {
    await stopServer()
    await status({ revision: '', ready: false, error: 'Waiting for a valid Filebrowser2 lease.', active: [], failed: [] })
    return
  }
  const shares: ControlShare[] = [], failed: string[] = []
  for (const share of control.shares) {
    try {
      if (!equalIdentity(await identity(share.storage.path, '/'), share.storage) || !equalIdentity(await identity(share.storage.path, share.path), share.directory)) throw new Error('Directory changed')
      shares.push(share)
    } catch { failed.push(share.id) }
  }
  const next = createHash('sha256').update(JSON.stringify({ revision: control.revision, active: shares.map(share => share.id) })).digest('hex')
  if (next !== effective || (shares.length && (!server || server.exitCode !== null || server.signalCode !== null))) {
    // A reload does not revoke existing SMB sessions. Replacing the daemon closes
    // client handles before applying account, scope or credential changes.
    await stopServer()
    const accounts = [...new Map(shares.map(share => [share.username, share])).values()]
    for (const share of accounts) await account(share)
    const filesystem = await filesystemAccount(control.access)
    const configPath = join(stateDirectory, 'smb.conf')
    await atomicFile(join(stateDirectory, 'smbpasswd'), accounts.map(share => `${share.username}:${share.uid}:${'X'.repeat(32)}:${share.ntHash}:[U          ]:LCT-${Math.floor(Date.now() / 1_000).toString(16).toUpperCase()}:`).join('\n') + '\n')
    await atomicFile(configPath, configuration(shares, filesystem))
    await execute('testparm', ['--suppress-prompt', configPath], { timeout: 5_000, maxBuffer: 64 * 1024 })
    // Preparing accounts or validating a configuration can outlast its lease.
    // Reject superseded policies before opening the listener or acknowledging.
    let latest = await readControl()
    if (stopping || latest.revision !== control.revision) return
    for (const share of shares) if (!equalIdentity(await identity(share.storage.path, '/'), share.storage) || !equalIdentity(await identity(share.storage.path, share.path), share.directory)) return
    latest = await readControl()
    if (stopping || latest.revision !== control.revision) return
    if (shares.length) {
      serverRevision = control.revision
      server = spawn('smbd', ['--foreground', '--no-process-group', '--configfile', configPath], { detached: true, stdio: 'ignore' })
      const child = server
      renewLease(latest)
      child.on('error', () => { effective = '' })
      child.on('exit', () => { if (server === child) effective = '' })
      await delay(150)
      if (server !== child || !child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('SMB server did not start')
    }
    effective = next
  }
  const latest = await readControl()
  if (stopping || latest.revision !== control.revision || (shares.length && (!server || serverRevision !== control.revision || server.exitCode !== null || server.signalCode !== null))) { await stopServer(); return }
  await status({ revision: control.revision, ready: true, error: '', active: shares.map(share => share.id), failed })
}

async function run() {
  if (process.argv.includes('--health')) {
    try {
      const health = agentStatusSchema.parse(JSON.parse(await readFile(join(controlDirectory, 'status.json'), 'utf8')))
      process.exit(health.ready && !health.error && Date.now() - health.checkedAt < 4_000 ? 0 : 1)
    } catch { process.exit(1) }
  }
  for (const directory of [stateDirectory, ...['private', 'state', 'cache', 'run', 'ncalrpc'].map(name => join(stateDirectory, name))]) await mkdir(directory, { recursive: true, mode: 0o700 })
  const stop = () => { stopping = true }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const monitoring = monitorLease()
  try {
    while (!stopping) {
      try { await reconcile() }
      catch (error) {
        await stopServer()
        console.error('SMB configuration failed:', error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : 'Unknown error')
        await status({ revision: '', ready: false, error: 'The SMB service could not apply its configuration.', active: [], failed: [] }).catch(() => {})
      }
      await delay(500)
    }
  } finally {
    stopping = true
    await monitoring
    await stopServer()
    await status({ revision: '', ready: false, error: 'The SMB service is stopped.', active: [], failed: [] }).catch(() => {})
  }
}
await run()
