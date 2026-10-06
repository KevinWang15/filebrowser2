// Run on the Docker host alongside the two container upload harnesses.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const output = resolve(process.env.FB_VERIFY_OUTPUT ?? 'verification')
const prefix = ['compose', '-p', 'filebrowser-verify', '-f', 'compose.verify.yml']
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim()
const compose = args => docker([...prefix, ...args])
const exists = async name => { try { await access(join(output, name)); return true } catch { return false } }
const events = []
const samples = []
await mkdir(join(output, 'logs'), { recursive: true })
const deadline = Date.now() + 10 * 60_000
let restarted = await exists('restart-done')
let filled = await exists('disk-pressure-ready')

try {
  while (Date.now() < deadline) {
    if (!filled && await exists('disk-pressure-request.json')) {
      const code = `const fs=require('node:fs');const fd=fs.openSync('/files/pressure-fixture.bin','w');const bytes=Buffer.alloc(1048576);let written=0;try{for(;;){const count=fs.writeSync(fd,bytes);if(!count)throw Error('No write progress');written+=count}}catch(error){if(error.code!=='ENOSPC')throw error;console.log(JSON.stringify({error:error.code,written,available:fs.statfsSync('/files').bavail*fs.statfsSync('/files').bsize}))}finally{fs.closeSync(fd)}`
      const result = JSON.parse(compose(['exec', '-T', 'diskfull', 'node', '-e', code]))
      assert.equal(result.error, 'ENOSPC'); assert.equal(result.available, 0)
      events.push({ event: 'filled-tmpfs-to-ENOSPC', time: new Date().toISOString(), ...result })
      await writeFile(join(output, 'disk-pressure-ready'), new Date().toISOString())
      filled = true
      console.log('Injected actual ENOSPC into diskfull container')
    }
    if (!restarted && await exists('restart-request.json')) {
      const checkpoint = JSON.parse(await readFile(join(output, 'restart-request.json'), 'utf8'))
      const previousPid = Number(docker(['inspect', '--format', '{{.State.Pid}}', 'filebrowser-verify-app-1']))
      compose(['kill', '-s', 'SIGKILL', 'app'])
      compose(['start', 'app'])
      let healthy = false
      for (let attempt = 0; attempt < 150; attempt++) {
        try { healthy = (await fetch('http://127.0.0.1:3320/health', { signal: AbortSignal.timeout(1000) })).ok } catch { /* wait for startup */ }
        if (healthy) break
        await delay(200)
      }
      assert.equal(healthy, true, 'Killed container did not become healthy')
      const nextPid = Number(docker(['inspect', '--format', '{{.State.Pid}}', 'filebrowser-verify-app-1']))
      assert.notEqual(previousPid, nextPid)
      events.push({ event: 'SIGKILL-and-restart', time: new Date().toISOString(), previousPid, nextPid, checkpoint })
      await writeFile(join(output, 'restart-done'), new Date().toISOString())
      restarted = true
      console.log(`Killed and restarted production server at ${checkpoint.committedBytes} acknowledged bytes`)
    }
    const sample = JSON.parse(docker(['stats', '--no-stream', '--format', '{{json .}}', 'filebrowser-verify-app-1']))
    samples.push({ time: new Date().toISOString(), memory: sample.MemUsage, cpu: sample.CPUPerc, pids: sample.PIDs })
    await writeFile(join(output, 'container-resource-samples.json'), JSON.stringify(samples, null, 2))
    if (await exists('large-upload-results.json') && await exists('disk-results.json')) {
      const large = JSON.parse(await readFile(join(output, 'large-upload-results.json'), 'utf8'))
      const disk = JSON.parse(await readFile(join(output, 'disk-results.json'), 'utf8'))
      assert.equal(large.status, 'PASS'); assert.equal(disk.status, 'PASS')
      assert.equal(restarted, true); assert.equal(filled, true)
      await writeFile(join(output, 'fault-injection-results.json'), JSON.stringify({ status: 'PASS', events, samples: samples.length }, null, 2))
      console.log(`Fault injection finished; ${samples.length} resource samples recorded`)
      process.exit(0)
    }
    await delay(500)
  }
  throw new Error('Container verification exceeded ten minutes')
} catch (error) {
  await writeFile(join(output, 'fault-injection-results.json'), JSON.stringify({ status: 'FAIL', events, error: error.stack }, null, 2))
  throw error
}
