// Host driver: starts no production services and reads only public fixture identities.
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const project = process.env.FB_TARGET_VERIFY_PROJECT ?? 'filebrowser-targets-verify'
const output = process.env.FB_TARGET_VERIFY_OUTPUT ?? 'verification/targets'
const prefix = ['compose', '-p', project, '-f', 'compose.targets.verify.yml']
const container = execFileSync('docker', [...prefix, 'ps', '-q', 'remotes'], { encoding: 'utf8' }).trim()
if (!container) throw new Error('Start the isolated remote fixtures before running verification')
// The fixture generates its TLS certificate on startup. Never copy a stale or
// missing certificate while the native protocol services are still starting.
for (let attempt = 0; ; attempt++) {
  const status = execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', container], { encoding: 'utf8' }).trim()
  if (status === 'healthy') break
  if (status === 'unhealthy' || attempt === 30) throw new Error('Remote protocol fixtures did not become healthy')
  await new Promise(resolve => setTimeout(resolve, 1000))
}
await mkdir(output, { recursive: true })
const key = execFileSync('docker', ['exec', container, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub', '-E', 'sha256'], { encoding: 'utf8' }).trim().split(/\s+/)[1]
execFileSync('docker', ['cp', container + ':/tmp/ftp.crt', resolve(output, 'ftp-fixture.crt')])
execFileSync('docker', [...prefix, 'up', '-d', '--no-build', '--no-deps', '--force-recreate', 'app'], { stdio: 'inherit' })
// Mount one evidence directory consistently even when its host location differs.
const common = [...prefix, 'run', '--rm', '-v', resolve(output) + ':/target-evidence', '-e', 'FB_TEST_REMOTES=true', '-e', 'FB_TEST_SFTP_HOST_KEY=' + key, '-e', 'NODE_EXTRA_CA_CERTS=/target-evidence/ftp-fixture.crt', '-e', 'FB_VERIFY_OUTPUT=/target-evidence', 'runner']
for (const [name, command] of [['remote-tests', ['node', '--import', 'tsx', '--test', 'tests/remote-storage.test.js']], ['target-browser', ['node', 'scripts/verify-container-targets.mjs']]]) {
  let log = ''
  const child = spawn('docker', [...common, ...command], { stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data; process.stdout.write(data) })
  const code = await new Promise(resolve => child.once('close', resolve))
  await writeFile(resolve(output, name + '.log'), log)
  if (code !== 0) throw new Error(name + ' failed with exit ' + code)
}
