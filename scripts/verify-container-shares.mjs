import { verificationTargetId, verificationLocalTarget } from './verification-targets.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, symlink, rename, rm, stat, open, chown } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
const url = process.env.FB_VERIFY_URL ?? 'http://app:3000'
const host = process.env.FB_VERIFY_SMB_HOST ?? 'smb'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence'
const files = process.env.FB_VERIFY_FILES ?? '/verify-files'
const password = 'protocol-container-admin-password'
const permissions = { read: true, download: true, upload: true, create: true, rename: true, delete: true }
let targetId = ''
const results = []
const temporary = await mkdtemp(join(tmpdir(), 'filebrowser-smb-client-'))
let admin = '', persistent
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const check = name => { results.push({ name, status: 'PASS' }); console.log('PASS ' + name) }
async function api(path, body, method = body === undefined ? 'GET' : 'POST', cookie = admin) {
  return fetch(url + '/api' + path, { method, headers: { cookie, 'X-Filebrowser-Request': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) })
}
async function json(response, expected = 200) { const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data }
async function authFile(credentials) {
  const path = join(temporary, 'auth-' + results.length + '-' + Math.random().toString(36).slice(2))
  await writeFile(path, `username = ${credentials.username}\npassword = ${credentials.password}\n`, { mode: 0o600 })
  return path
}
function clientArgs(name, authentication, command, extra = []) {
  return [`//${host}/${name}`, '--use-kerberos=off', '--client-protection=encrypt', '-m', 'SMB3', ...(authentication ? ['-A', authentication] : ['-N']), ...extra, '-c', command]
}
async function client(name, authentication, command, succeeds = true, extra = [], timeout = 12_000) {
  let outcome
  try { outcome = { code: 0, ...(await execute('smbclient', clientArgs(name, authentication, command, extra), { timeout, maxBuffer: 1024 * 1024 })) } }
  catch (error) { outcome = { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }
  if (succeeds) assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr)
  else {
    const denial = /NT_STATUS_(?!OK\b|SUCCESS\b)[A-Z0-9_]+/.test(outcome.stdout + outcome.stderr)
    assert.ok(outcome.code !== 0 || denial, 'Unexpected SMB access: ' + command)
    if (command.startsWith('get ')) {
      const local = command.match(/"([^"]+)"$/)?.[1]
      if (local) {
        try { assert.equal((await stat(local)).size, 0, 'Denied SMB read returned bytes') }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
  }
  return outcome.stdout + outcome.stderr
}
async function encryptedProbe(authentication, bytes) {
  const sockets = new Set(), clearCommands = []
  let encryptedFrames = 0
  const inspect = () => {
    let pending = Buffer.alloc(0)
    return data => {
      pending = Buffer.concat([pending, data])
      while (pending.length >= 4) {
        const size = pending.readUIntBE(1, 3)
        if (pending.length < size + 4) break
        const packet = pending.subarray(4, size + 4)
        if (packet.subarray(0, 4).equals(Buffer.from([0xfd, 0x53, 0x4d, 0x42]))) encryptedFrames++
        else if (packet.length >= 14 && packet.subarray(0, 4).equals(Buffer.from([0xfe, 0x53, 0x4d, 0x42]))) clearCommands.push(packet.readUInt16LE(12))
        pending = pending.subarray(size + 4)
      }
    }
  }
  const proxy = createServer(socket => {
    const upstream = createConnection({ host, port: 445 })
    for (const connection of [socket, upstream]) {
      sockets.add(connection)
      connection.on('data', inspect())
      connection.on('error', () => { socket.destroy(); upstream.destroy() })
      connection.once('close', () => sockets.delete(connection))
    }
    socket.pipe(upstream); upstream.pipe(socket)
  })
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve) })
  const target = join(temporary, 'encryption-probe.bin')
  try {
    // Samba 4.17 may still honor mandatory server encryption when a client's
    // preference is off. Observe actual SMB transform frames, not flag names.
    await client('Team', authentication, `get "report-日本語.txt" "${target}"`, true,
      ['--client-protection=off', '--option=client smb encrypt=off', '-I', '127.0.0.1', '-p', String(proxy.address().port)])
    assert.equal(digest(await readFile(target)), digest(bytes))
    assert.ok(encryptedFrames > 0, 'SMB transfer did not use encrypted transform frames')
    assert.ok(!clearCommands.some(command => [5, 8, 14, 16].includes(command)), 'SMB file operations appeared in plaintext')
    console.log('SMB_ENCRYPTION ' + JSON.stringify({ encryptedFrames, plaintextFileOperations: 0 }))
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => proxy.close(resolve))
    await rm(target, { force: true })
  }
}
async function ready(id, desired = 'active') {
  for (let attempt = 0; attempt < 100; attempt++) {
    const data = await json(await api('/shares'))
    const share = data.shares.find(share => share.id === id)
    if (share?.status === desired) return share
    await delay(100)
  }
  throw new Error('Share status did not become ' + desired)
}
async function upload(name, bytes, directory = '/Team') {
  let session = await json(await api('/uploads', { targetId, name, directory, size: bytes.length, lastModified: 0, chunkSize: 102400, hashes: bytes.length ? [digest(bytes)] : [] }), 201)
  if (bytes.length) {
    const attempt = await json(await api(`/uploads/${session.id}/chunks/0/start`, { connections: 4 }))
    for (const part of attempt.parts) {
      const response = await fetch(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${part.index}`, { method: 'PUT', headers: { cookie: admin, 'X-Filebrowser-Request': '1', 'Content-Type': 'application/octet-stream' }, body: bytes.subarray(part.offset, part.offset + part.size), signal: AbortSignal.timeout(15_000) })
      assert.equal(response.status, 204, await response.text())
    }
    session = await json(await api(`/uploads/${session.id}/chunks/0/commit`, { attemptId: attempt.id }))
  }
  return json(await api(`/uploads/${session.id}/complete`, {}))
}

await mkdir(output, { recursive: true })
try {
  const bootstrap = await json(await api('/bootstrap'))
  if (bootstrap.needsSetup) {
    const response = await api('/setup', { username: 'admin', password, siteName: 'Protocol verification', target: verificationLocalTarget() })
    assert.equal(response.status, 201)
    admin = response.headers.get('set-cookie').split(';')[0]
  } else {
    const response = await api('/auth/login', { username: 'admin', password })
    assert.equal(response.status, 200)
    admin = response.headers.get('set-cookie').split(';')[0]
  }
  targetId = verificationTargetId(await json(await api('/bootstrap')))
  for (const name of ['Team', 'Other']) await json(await api(`/targets/${targetId}/files/directories`, { directory: '/', name }))
  const bytes = Buffer.from('Read-only SMB and web access agree. 日本語\n'.repeat(1500))
  await upload('report-日本語.txt', bytes)
  await upload('private.txt', Buffer.from('Another user’s folder.'), '/Other')
  const memberBody = { username: 'member', password: 'protocol-member-browser-password', role: 'user', grants:[{targetId,scope:'/Team',permissions}], disabled: false }
  const member = await json(await api('/admin/users', memberBody), 201)
  const adminUser = (await json(await api('/bootstrap'))).user
  const team = await json(await api('/admin/shares', { targetId, name: 'Team', path: '/Team', ownerId: member.id }), 201)
  const other = await json(await api('/admin/shares', { targetId, name: 'Other', path: '/Other', ownerId: adminUser.id }), 201)
  await ready(team.share.id)
  await ready(other.share.id)
  let authentication = await authFile(team)
  await client('Team', authentication, 'ls')
  check('native SMB3 client authenticates with independently issued credentials')
  for (const protocol of ['NT1', 'SMB2']) {
    await client('Team', authentication, 'ls', false, ['-m', protocol, '--option=client min protocol=' + protocol, '--client-protection=off'])
  }
  await encryptedProbe(authentication, bytes)
  check('SMB1 and SMB2 are rejected; SMB3 file operations use encryption even with client protection off')
  await client('Team', null, 'ls', false)
  await client('Team', await authFile({ username: team.username, password: 'incorrect' }), 'ls', false)
  await client('Other', authentication, 'ls', false)
  const enumeration = await execute('smbclient', ['-L', host, '-g', '-A', authentication, '--use-kerberos=off', '-m', 'SMB3'], { timeout: 12_000 })
  assert.ok(enumeration.stdout.includes('Team'))
  assert.ok(!enumeration.stdout.includes('Disk|Other|'))
  check('guest, incorrect credentials, cross-user access and share enumeration are restricted')
  const downloaded = join(temporary, 'downloaded.bin')
  await client('Team', authentication, `get "report-日本語.txt" "${downloaded}"`)
  assert.equal(digest(await readFile(downloaded)), digest(bytes))
  await rm(downloaded)
  const web = await api(`/targets/${targetId}/files/content?path=` + encodeURIComponent('/Team/report-日本語.txt'))
  assert.equal(digest(Buffer.from(await web.arrayBuffer())), digest(bytes))
  check('Unicode file downloaded through SMB and HTTP matches the full source SHA-256')
  const largeSize = 257 * 1024 * 1024
  const largePath = join(files, 'Team', 'large-native.bin')
  const expected = createHash('sha256'), block = Buffer.alloc(1024 * 1024)
  const handle = await open(largePath, 'wx', 0o644)
  try {
    for (let index = 0; index < 257; index++) {
      block.fill(index % 251); block.writeBigUInt64LE(BigInt(index))
      await handle.writeFile(block); expected.update(block)
    }
    await handle.sync()
  } finally { await handle.close() }
  const largeHash = expected.digest('hex')
  const partial = join(temporary, 'large-resume.bin')
  const initial = await open(partial, 'wx')
  try { for await (const bytes of createReadStream(largePath, { end: 5 * 1024 * 1024 - 1 })) await initial.writeFile(bytes) }
  finally { await initial.close() }
  await client('Team', authentication, `reget large-native.bin "${partial}"`, true, [], 90_000)
  assert.equal((await stat(partial)).size, largeSize)
  const received = createHash('sha256')
  for await (const bytes of createReadStream(partial)) received.update(bytes)
  assert.equal(received.digest('hex'), largeHash)
  const range = await fetch(url + `/api/targets/${targetId}/files/content?path=/Team/large-native.bin`, { headers: { cookie: admin, Range: 'bytes=5242880-5242943' } })
  assert.equal(range.status, 206)
  const rangeFile = await open(largePath, 'r')
  try { const sample = Buffer.alloc(64); await rangeFile.read(sample, 0, 64, 5 * 1024 * 1024); assert.deepEqual(Buffer.from(await range.arrayBuffer()), sample) }
  finally { await rangeFile.close() }
  await rm(partial)
  check('257 MiB SMB reget resumes a partial download to the full source SHA-256; HTTP ranges agree')
  await writeFile(join(temporary, 'write.txt'), 'must not be uploaded')
  for (const command of [`put "${join(temporary, 'write.txt')}" denied.txt`, 'mkdir denied', 'rename report-日本語.txt renamed.txt', 'del report-日本語.txt']) await client('Team', authentication, command, false)
  assert.equal(digest(await readFile(join(files, 'Team', 'report-日本語.txt'))), digest(bytes))
  for (const name of ['denied', 'denied.txt', 'renamed.txt']) await assert.rejects(stat(join(files, 'Team', name)), { code: 'ENOENT' })
  check('SMB upload, mkdir, rename and deletion are rejected without changing data')
  await mkdir(join(files, 'Team', '.filebrowser-test-private'))
  await writeFile(join(files, 'Team', '.filebrowser-test-private', 'secret.txt'), 'synthetic private fixture')
  await symlink('/etc/passwd', join(files, 'Team', 'outside-link'))
  await client('Team', authentication, `get .filebrowser-test-private/secret.txt "${downloaded}"`, false)
  await client('Team', authentication, `get outside-link "${downloaded}"`, false)
  await client('Team', authentication, `get ../Other/private.txt "${downloaded}"`, false)
  check('reserved state, symlinks and traversal cannot escape the exported directory')
  await writeFile(join(files, 'Team', 'root-only.txt'), 'synthetic OS permission fixture', { mode: 0o600 })
  const rootAccess = process.env.FB_VERIFY_ACCESS_UID === '0'
  await client('Team', authentication, `get root-only.txt "${downloaded}"`, rootAccess)
  assert.equal((await api(`/targets/${targetId}/files/content?path=/Team/root-only.txt`)).ok, rootAccess)
  if (rootAccess) { assert.equal(await readFile(downloaded, 'utf8'), 'synthetic OS permission fixture'); await rm(downloaded) }
  check('SMB file access uses the application’s OS identity without escalating filesystem permissions')
  if (process.env.FB_VERIFY_SUPPLEMENTARY_GID) {
    const groupFile = join(files, 'Team', 'group-only.txt')
    await writeFile(groupFile, 'supplementary group fixture', { mode: 0o640 })
    await chown(groupFile, 0, Number(process.env.FB_VERIFY_SUPPLEMENTARY_GID))
    await client('Team', authentication, `get group-only.txt "${downloaded}"`)
    assert.equal(await readFile(downloaded, 'utf8'), 'supplementary group fixture')
    assert.equal(await (await api(`/targets/${targetId}/files/content?path=/Team/group-only.txt`)).text(), 'supplementary group fixture')
    await rm(downloaded)
    check('SMB retains the application’s supplementary-group filesystem access')
  }
  const pendingBytes = Buffer.from('Pending files cannot be downloaded through SMB.')
  const pending = await json(await api('/uploads', { targetId, name: 'pending.bin', directory: '/Team', size: pendingBytes.length, chunkSize: 102400, lastModified: 0, hashes: [digest(pendingBytes)] }), 201)
  const listing = await client('Team', authentication, 'ls')
  assert.ok(!listing.includes('pending.bin.uploading'))
  await client('Team', authentication, `get pending.bin.uploading "${downloaded}"`, false)
  await json(await api('/uploads/' + pending.id, undefined, 'DELETE'))
  check('upload aliases and private staging stay inaccessible to native SMB clients')
  const additional = await json(await api('/admin/shares', { targetId, name: 'TeamAgain', path: '/Team', ownerId: member.id }), 201)
  assert.equal(additional.username, team.username)
  assert.equal(additional.password, null)
  await ready(additional.share.id)
  await client('TeamAgain', authentication, 'ls')
  check('multiple shares for one user use one SMB identity and retain the original password')
  const rotated = await json(await api('/admin/shares/' + team.share.id + '/credentials', {}))
  await ready(team.share.id)
  await client('Team', authentication, 'ls', false)
  authentication = await authFile(rotated)
  await client('TeamAgain', authentication, 'ls')
  check('password rotation revokes old credentials across every share belonging to the user')
  // smbclient's interactive readline requires a terminal, even in a headless test.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const interactive = ['smbclient', `//${host}/Team`, '-A', authentication, '--use-kerberos=off', '--client-protection=encrypt', '-m', 'SMB3', '-t', '2']
  persistent = spawn('script', ['--quiet', '--return', '--command', interactive.map(quote).join(' '), '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let sessionOutput = ''
  persistent.stdout.on('data', bytes => { sessionOutput += bytes })
  persistent.stderr.on('data', bytes => { sessionOutput += bytes })
  persistent.stdin.write('ls\n')
  for (let attempt = 0; attempt < 100 && !sessionOutput.includes('report-日本語.txt'); attempt++) await delay(50)
  assert.ok(sessionOutput.includes('report-日本語.txt'), sessionOutput)
  const before = sessionOutput.length
  await json(await api('/admin/users/' + member.id, { ...memberBody, password: undefined, disabled: true }, 'PATCH'))
  if (persistent.exitCode === null) persistent.stdin.write('ls\n')
  for (let attempt = 0; attempt < 100 && persistent.exitCode === null && !/disconnected|closed|UNSUCCESSFUL|CONNECTION|NETWORK|broken|failed|TIMED_OUT/i.test(sessionOutput.slice(before)); attempt++) await delay(50)
  assert.ok(persistent.exitCode !== null || /disconnected|closed|UNSUCCESSFUL|CONNECTION|NETWORK|broken|failed|TIMED_OUT/i.test(sessionOutput.slice(before)), sessionOutput.slice(before))
  persistent.kill('SIGTERM'); persistent = undefined
  await client('Team', authentication, 'ls', false)
  check('disabling the owner closes an already authenticated SMB connection and denies new ones')
  await json(await api('/admin/users/' + member.id, { ...memberBody, password: undefined }, 'PATCH'))
  await ready(team.share.id)
  await client('Team', authentication, 'ls')
  await rename(join(files, 'Team'), join(files, 'Team-original'))
  await mkdir(join(files, 'Team'))
  await writeFile(join(files, 'Team', 'replacement.txt'), 'not the original shared directory')
  await ready(team.share.id, 'blocked')
  await client('Team', authentication, 'ls', false)
  await client('Other', await authFile(other), 'ls')
  check('replaced directory identities fail closed while independent shares keep working')
  const secondFiles = '/verify-files-second'
  await chown(secondFiles, 1000, 1000)
  await writeFile(join(secondFiles, 'second.txt'), 'Independent local target')
  const secondTarget = await json(await api('/admin/targets', { name: 'Second local', enabled: true, readOnly: false, connection: { type: 'local', root: '/files-second' } }), 201)
  const secondShare = await json(await api('/admin/shares', { targetId: secondTarget.id, name: 'SecondTarget', path: '/', ownerId: adminUser.id }), 201)
  await ready(secondShare.share.id)
  await client('SecondTarget', await authFile(other), `get "second.txt" "${downloaded}"`)
  assert.equal((await readFile(downloaded, 'utf8')), 'Independent local target')
  await rm(downloaded)
  const change = { name: secondTarget.name, enabled: false, readOnly: false, connection: secondTarget.connection }
  await json(await api('/admin/targets/' + secondTarget.id, change, 'PATCH'))
  await client('SecondTarget', await authFile(other), 'ls', false)
  await client('Other', await authFile(other), 'ls')
  await json(await api('/admin/targets/' + secondTarget.id, { ...change, enabled: true }, 'PATCH'))
  await ready(secondShare.share.id)
  await client('SecondTarget', await authFile(other), 'ls')
  assert.equal((await api('/admin/shares/' + secondShare.share.id, undefined, 'DELETE')).status, 204)
  assert.equal((await api('/admin/targets/' + secondTarget.id, undefined, 'DELETE')).status, 204)
  check('native shares use independent local roots; disabling one target revokes only its exports')
  const publicShares = await (await api('/shares')).text()
  assert.ok(!publicShares.includes(rotated.password))
  assert.ok(!publicShares.includes('ntHash') && !publicShares.includes('secret'))
  check('public sharing metadata contains neither passwords nor NT verifiers')
  await writeFile(join(output, 'smb-results.json'), JSON.stringify({ status: 'PASS', client: 'smbclient SMB3', results }, null, 2))
} catch (error) {
  await writeFile(join(output, 'smb-results.json'), JSON.stringify({ status: 'FAIL', error: error.message, results }, null, 2))
  throw error
} finally {
  persistent?.kill('SIGTERM')
  await rm(temporary, { recursive: true, force: true })
}
