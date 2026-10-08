import { localTarget, firstTarget } from './fixtures/targets.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { CHUNK_SIZE } from '../shared/types.ts'

const entry=fileURLToPath(new URL('./fixtures/crash-server.js',import.meta.url))
async function start(root,crashAt='') {
  const processChild=spawn(process.execPath,['--import','tsx',entry],{env:{...process.env,FB_STATE_DIR:join(root,'state'),FB_CRASH_AT:crashAt},stdio:['ignore','pipe','pipe']})
  let output=''
  processChild.stdout.on('data',chunk=>{output+=chunk})
  processChild.stderr.on('data',chunk=>{output+=chunk})
  const closed=once(processChild,'close')
  for(let i=0;i<200&&!output.includes('READY ')&&processChild.exitCode===null;i++)await delay(50)
  const address=/READY (http:\/\/\S+)/.exec(output)?.[1]
  if(!address){processChild.kill('SIGKILL');throw new Error(output||'Crash-test server did not start')}
  return {address,closed,async stop(){if(processChild.exitCode===null&&processChild.signalCode===null){processChild.kill('SIGTERM');await closed}}}
}

for(const crashAt of ['append','publish-link','publish','cancel']) {
  test(`SIGKILL after ${crashAt} recovers atomically without duplicate bytes`,{timeout:30000},async t=>{
    const root=await mkdtemp(join(tmpdir(),'filebrowser-crash-'))
    let server=await start(root,crashAt)
    t.after(async()=>{await server.stop();await rm(root,{recursive:true,force:true})})
    let cookie=''
    const request=async(path,body,method)=>{
      const response=await fetch(server.address+'/api'+path,{method:method??(body===undefined?'GET':'POST'),headers:{'x-filebrowser-request':'1',...(body===undefined?{}:{'content-type':'application/json'}),cookie},body:body===undefined?undefined:JSON.stringify(body)})
      return response
    }
    const setup=await request('/setup',{username:'admin',password:'crash-test-secure-password',siteName:'Crash test',target:localTarget(join(root,'files'))})
    cookie=setup.headers.get('set-cookie').split(';')[0]
    const targetId = await firstTarget(request)
    const data=Buffer.from('Every byte must appear exactly once, even after SIGKILL.\n'.repeat(2000))
    const session=await (await request('/uploads',{targetId: targetId, name:'crash.txt',directory:'/',size:data.length,lastModified:0,chunkSize:CHUNK_SIZE,hashes:[createHash('sha256').update(data).digest('hex')]})).json()
    const upload=async()=>{
      const attempt=await (await request(`/uploads/${session.id}/chunks/0/start`,{connections:1})).json()
      const part=await fetch(`${server.address}/api/uploads/${session.id}/attempts/${attempt.id}/parts/0`,{method:'PUT',headers:{cookie,'x-filebrowser-request':'1','content-type':'application/octet-stream'},body:data})
      assert.equal(part.status,204)
      return request(`/uploads/${session.id}/chunks/0/commit`,{attemptId:attempt.id})
    }
    if(crashAt==='append')await assert.rejects(upload())
    else {
      assert.equal((await upload()).status,200)
      if(crashAt==='cancel')await assert.rejects(request(`/uploads/${session.id}`,undefined,'DELETE'))
      else await assert.rejects(request(`/uploads/${session.id}/complete`,{}))
    }
    const [,signal]=await server.closed
    assert.equal(signal,'SIGKILL')
    if(crashAt==='publish-link') {
      assert.equal((await stat(join(root,'files','crash.txt'))).ino,(await stat(join(root,'files','crash.txt.uploading'))).ino)
    }
    server=await start(root)
    const saved=await (await request(`/uploads/${session.id}`)).json()
    if(crashAt==='append') {
      assert.equal(saved.nextChunk,0);assert.equal(saved.committedBytes,0)
      assert.equal((await stat(join(root,'files','.filebrowser-uploads',session.id,'target.uploading'))).size,0)
      assert.equal((await upload()).status,200)
      assert.equal((await request(`/uploads/${session.id}/complete`,{})).status,200)
    } else if(crashAt==='cancel')assert.equal(saved.status,'canceled')
    else assert.equal(saved.status,'completed')
    if(crashAt==='cancel')await assert.rejects(stat(join(root,'files','crash.txt')), {code:'ENOENT'})
    else assert.deepEqual(await readFile(join(root,'files','crash.txt')),data)
    await assert.rejects(stat(join(root,'files','crash.txt.uploading')), {code:'ENOENT'})
    assert.deepEqual(await readdir(join(root,'files','.filebrowser-uploads')),[])
  })
}
