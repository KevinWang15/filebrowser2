import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, rm, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const project=fileURLToPath(new URL('../',import.meta.url))
test('relocated production bundle serves setup, authenticated files, static assets, and shuts down cleanly',{timeout:60000},async t=>{
  try { await access(join(project,'dist/server/server.js'));await access(join(project,'dist/client/index.html')) }
  catch { const execute=promisify(execFile);await execute('npm',['run','build:client'],{cwd:project});await execute('npm',['run','build:server'],{cwd:project}) }
  const root=await mkdtemp(join(tmpdir(),'filebrowser-production-'))
  await cp(join(project,'dist'),join(root,'dist'),{recursive:true})
  await cp(join(project,'package.json'),join(root,'package.json'))
  await symlink(join(project,'node_modules'),join(root,'node_modules'),'junction')
  const child=spawn(process.execPath,['--enable-source-maps',join(root,'dist/server/server.js')],{cwd:root,env:{...process.env,PORT:'0',HOST:'127.0.0.1',FB_STORAGE_ROOT:join(root,'files'),FB_STATE_DIR:join(root,'state')},stdio:['ignore','pipe','pipe']})
  const closed=once(child,'close')
  let output=''
  child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{output+=chunk})
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await closed}await rm(root,{recursive:true,force:true})})
  for(let i=0;i<200&&!/^Server listening at /m.test(output);i++)await delay(50)
  const address=/^Server listening at (http:\/\/\S+)$/m.exec(output)?.[1]
  assert.ok(address,output)
  const html=await(await fetch(address)).text()
  assert.match(html,/Filebrowser/)
  for(const match of html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g))assert.equal((await fetch(address+match[1])).status,200)
  assert.equal((await fetch(address+'/assets/missing.js')).status,404)
  assert.equal((await fetch(address+'/api/files')).status,401)
  const setup=await fetch(address+'/api/setup',{method:'POST',headers:{'content-type':'application/json','x-filebrowser-request':'1'},body:JSON.stringify({username:'admin',password:'production-test-password',siteName:'Production'})})
  assert.equal(setup.status,201,await setup.clone().text())
  const cookie=setup.headers.get('set-cookie').split(';')[0]
  assert.deepEqual((await(await fetch(address+'/api/files',{headers:{cookie}})).json()).entries,[])
  child.kill('SIGTERM')
  const [code,signal]=await closed
  assert.equal(code,0,output);assert.equal(signal,null)
})
