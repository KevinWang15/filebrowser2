// Run on the Docker host after native verification, against only its disposable project.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const execute = promisify(execFile)
const output = resolve(process.env.FB_VERIFY_OUTPUT ?? 'verification')
const project = process.env.FB_VERIFY_PROJECT ?? 'filebrowser-smb-verify'
const files = ['compose.verify.yml', 'compose.verify.smb.yml', ...(process.env.FB_VERIFY_COMPOSE_OVERRIDE ? [process.env.FB_VERIFY_COMPOSE_OVERRIDE] : [])]
const prefix = ['compose', '-p', project, ...files.flatMap(file => ['-f', file])]
const compose = async args => (await execute('docker', [...prefix, ...args], { timeout: 30_000 })).stdout.trim()
const control = join(output, 'recovery-control')
const events = []
let child
async function wait(name) {
  for (let attempt = 0; attempt < 350; attempt++) {
    if (child.exitCode !== null) throw new Error('Recovery client exited before ' + name)
    try { await readFile(join(control, name)); return } catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(100)
  }
  throw new Error('Recovery client did not request ' + name)
}
async function signal(name) { await writeFile(join(control, name), '') }
async function companionUnavailable() {
  for (let attempt = 0; attempt < 130; attempt++) {
    try {
      const status = JSON.parse(await compose(['exec', '-T', 'smb', 'node', '-e', "process.stdout.write(require('fs').readFileSync('/control/status.json','utf8'))"]))
      if (!status.ready) return status
    } catch { /* Wait for the companion to publish its denial. */ }
    await delay(100)
  }
  throw new Error('SMB access was not revoked')
}
async function healthy() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await compose(['exec', '-T', 'app', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]); return } catch { await delay(100) }
  }
  throw new Error('Application did not recover')
}
try {
  await mkdir(output, { recursive: true })
  await rm(control, { recursive: true, force: true })
  await mkdir(control)
  assert.ok(await compose(['ps', '-q', 'app']))
  assert.ok(await compose(['ps', '-q', 'smb']))
  child = spawn('docker', [...prefix, 'run', '--rm', '--no-deps', 'smb-client', 'node', 'scripts/verify-container-shares-faults.mjs'], { stdio: 'inherit' })
  const completion = new Promise(resolve => child.once('exit', code => resolve(code)))
  await wait('restart-smb-request')
  await compose(['restart', 'smb'])
  events.push({ event: 'Samba companion restarted', time: new Date().toISOString() })
  await signal('restart-smb-done')
  await wait('kill-app-request')
  await compose(['kill', '-s', 'SIGKILL', 'app'])
  const killedAt = Date.now()
  let expired = false
  for (let attempt = 0; attempt < 130; attempt++) {
    try {
      const status = JSON.parse(await compose(['exec', '-T', 'smb', 'node', '-e', "process.stdout.write(require('fs').readFileSync('/control/status.json','utf8'))"]))
      if (!status.ready && status.error === 'Waiting for a valid Filebrowser2 lease.') { expired = true; break }
    } catch { /* Wait for the companion to publish its denial. */ }
    await delay(100)
  }
  assert.ok(expired, 'Control lease did not fail closed')
  const denialMs = Date.now() - killedAt
  assert.ok(denialMs <= 11_500, 'Lease revocation exceeded the documented lease and poll interval')
  events.push({ event: 'Application SIGKILL; SMB lease expired', denialMs, time: new Date().toISOString() })
  await signal('lease-expired')
  await wait('restart-app-request')
  await compose(['start', 'app'])
  await healthy()
  events.push({ event: 'Application restarted with existing persistent state', time: new Date().toISOString() })
  await signal('restart-app-done')
  await wait('invalid-control-request')
  await compose(['pause', 'app'])
  await compose(['exec', '-T', 'smb', 'node', '-e', "require('fs').writeFileSync('/control/desired.json','invalid verification fixture')"])
  await companionUnavailable()
  events.push({ event: 'Invalid control file revoked native access', time: new Date().toISOString() })
  await signal('invalid-control-done')
  await wait('restore-control-request')
  await compose(['unpause', 'app'])
  await signal('restore-control-done')
  await wait('stop-smb-request')
  await compose(['stop', 'smb'])
  await signal('stop-smb-done')
  await wait('start-smb-request')
  await compose(['start', 'smb'])
  await signal('start-smb-done')
  await wait('slow-config-request')
  const wrapper = '#!/bin/sh\nif [ -f /control/verify-delay-config ]; then\n  rm /control/verify-delay-config\n  touch /control/verify-config-delayed\n  sleep 4\nfi\nexec /usr/bin/testparm "$@"\n'
  await compose(['exec', '-T', 'smb', 'node', '-e', "const fs=require('fs');fs.writeFileSync('/usr/local/bin/testparm',process.argv[1],{mode:0o755});fs.writeFileSync('/control/verify-delay-config','');", wrapper])
  await signal('slow-config-ready')
  let delayed = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await compose(['exec', '-T', 'smb', 'test', '-f', '/control/verify-config-delayed']); delayed = true; break } catch { await delay(50) }
  }
  assert.ok(delayed, 'Configuration delay was not exercised')
  await compose(['pause', 'app'])
  await compose(['exec', '-T', 'smb', 'node', '-e', "const fs=require('fs');const p=JSON.parse(fs.readFileSync('/control/desired.json','utf8'));p.expiresAt=0;fs.writeFileSync('/control/expired-verification.json',JSON.stringify(p),{mode:0o600});fs.renameSync('/control/expired-verification.json','/control/desired.json');"])
  await signal('slow-control-expired')
  await wait('restore-slow-request')
  await compose(['unpause', 'app'])
  await signal('restore-slow-done')
  events.push({ event: 'Expired policy did not reopen access after delayed configuration', time: new Date().toISOString() })
  await wait('superseded-config-request')
  await compose(['exec', '-T', 'smb', 'node', '-e', "const fs=require('fs');fs.unlinkSync('/control/verify-config-delayed');fs.writeFileSync('/control/verify-delay-config','');"])
  await signal('superseded-config-ready')
  delayed = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await compose(['exec', '-T', 'smb', 'test', '-f', '/control/verify-config-delayed']); delayed = true; break } catch { await delay(50) }
  }
  assert.ok(delayed, 'Superseded configuration delay was not exercised')
  const previousRevision = await compose(['exec', '-T', 'smb', 'node', '-e', "process.stdout.write(JSON.parse(require('fs').readFileSync('/control/desired.json','utf8')).revision)"])
  await signal('superseded-config-started')
  let updated = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const revision = await compose(['exec', '-T', 'smb', 'node', '-e', "process.stdout.write(JSON.parse(require('fs').readFileSync('/control/desired.json','utf8')).revision)"])
    if (revision !== previousRevision) { updated = true; break }
    await delay(50)
  }
  assert.ok(updated, 'The newer share policy was not published')
  await signal('superseded-revision-published')
  events.push({ event: 'Superseded policy did not reopen a disabled share', time: new Date().toISOString() })
  await wait('control-write-failure-request')
  await compose(['exec', '-T', 'smb', 'chmod', '500', '/control'])
  await signal('control-write-failure-ready')
  await wait('restore-write-request')
  await compose(['exec', '-T', 'smb', 'chmod', '700', '/control'])
  await signal('restore-write-done')
  events.push({ event: 'Control write failure preserves committed account and credential responses', time: new Date().toISOString() })
  assert.equal(await completion, 0)
  assert.equal(JSON.parse(await readFile(join(output, 'smb-recovery-client-results.json'), 'utf8')).status, 'PASS')
  await writeFile(join(output, 'smb-recovery-results.json'), JSON.stringify({ status: 'PASS', events }, null, 2))
} catch (error) {
  await writeFile(join(output, 'smb-recovery-results.json'), JSON.stringify({ status: 'FAIL', error: error.message, events }, null, 2)).catch(() => {})
  throw error
} finally {
  if (child?.exitCode === null) child.kill('SIGTERM')
  await compose(['exec', '-T', 'smb', 'chmod', '700', '/control']).catch(() => {})
  await compose(['unpause', 'app']).catch(() => {})
  await compose(['start', 'app']).catch(() => {})
  await rm(control, { recursive: true, force: true })
}
