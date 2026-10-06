import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm, stat, open, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from '../backend/app.ts'
import { CHUNK_SIZE } from '../shared/types.ts'

test('real 100 MiB chunk, interrupted connections, strict ordering, and a 200 GiB manifest',{timeout:60000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'filebrowser-large-'))
  const app=await createApp({storageRoot:join(root,'files'),stateDirectory:join(root,'state')})
  const url=await app.listen({host:'127.0.0.1',port:0})
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})})
  let cookie=''
  const json=async(path,body)=>fetch(url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'x-filebrowser-request':'1',...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)})
  const setup=await json('/setup',{username:'admin',password:'large-upload-test-password',siteName:'Large upload'})
  cookie=setup.headers.get('set-cookie').split(';')[0]
  const block=Buffer.alloc(1024*1024,0x42)
  const hash=createHash('sha256')
  for(let i=0;i<100;i++)hash.update(block)
  const fullHash=hash.digest('hex')
  const tail=Buffer.from('Verified final bytes.')
  const manifest={name:'two-chunks.bin',directory:'/',size:CHUNK_SIZE+tail.length,lastModified:0,chunkSize:CHUNK_SIZE,hashes:[fullHash,createHash('sha256').update(tail).digest('hex')]}
  const session=await (await json('/uploads',manifest)).json()
  assert.ok(session.id)
  const stage=join(root,'files','.filebrowser-uploads',session.id)
  let attempt=await (await json(`/uploads/${session.id}/chunks/0/start`,{connections:1})).json()
  // Write only 1 MiB of the promised chunk, then drop the TCP connection.
  await new Promise(resolve=>{
    const req=httpRequest(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/0`,{method:'PUT',headers:{cookie,'x-filebrowser-request':'1','content-type':'application/octet-stream','content-length':CHUNK_SIZE}},res=>res.resume())
    req.on('error',()=>resolve())
    req.write(block,()=>setTimeout(()=>req.destroy(),50))
  })
  for(let i=0;i<100;i++) {
    const files=await readdir(stage)
    if(!files.includes('chunk'))break
    await delay(20)
  }
  assert.equal((await stat(join(stage,'target.uploading'))).size,0)
  assert.deepEqual(await readdir(stage),['destination.json','target.uploading'])
  assert.equal((await json(`/uploads/${session.id}/chunks/1/start`,{connections:4})).status,409)
  attempt=await (await json(`/uploads/${session.id}/chunks/0/start`,{connections:4})).json()
  const responses=await Promise.all(attempt.parts.map(async part=>{
    async function* source(){let remaining=part.size;while(remaining>0){const size=Math.min(remaining,block.length);yield block.subarray(0,size);remaining-=size}}
    return fetch(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${part.index}`,{method:'PUT',headers:{cookie,'x-filebrowser-request':'1','content-type':'application/octet-stream','content-length':String(part.size)},body:Readable.toWeb(Readable.from(source())),duplex:'half'})
  }))
  for(const response of responses)assert.equal(response.status,204,await response.text())
  assert.equal((await stat(join(stage,'chunk'))).size,CHUNK_SIZE)
  assert.equal((await stat(join(stage,'target.uploading'))).size,0)
  const commit=await json(`/uploads/${session.id}/chunks/0/commit`,{attemptId:attempt.id})
  assert.equal(commit.status,200,await commit.clone().text())
  assert.equal((await commit.json()).committedBytes,CHUNK_SIZE)
  assert.equal((await json(`/uploads/${session.id}/complete`,{})).status,409)
  attempt=await (await json(`/uploads/${session.id}/chunks/1/start`,{connections:2})).json()
  const tailParts=await Promise.all(attempt.parts.map(p=>fetch(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${p.index}`,{method:'PUT',headers:{cookie,'x-filebrowser-request':'1','content-type':'application/octet-stream'},body:tail.subarray(p.offset,p.offset+p.size)})))
  for(const part of tailParts)assert.equal(part.status,204)
  assert.equal((await json(`/uploads/${session.id}/chunks/1/commit`,{attemptId:attempt.id})).status,200)
  assert.equal((await json(`/uploads/${session.id}/complete`,{})).status,200)
  const file=await open(join(root,'files','two-chunks.bin'),'r')
  try {
    assert.equal((await file.stat()).size,CHUNK_SIZE+tail.length)
    const bytes=Buffer.alloc(tail.length)
    await file.read(bytes,0,tail.length,CHUNK_SIZE)
    assert.deepEqual(bytes,tail)
  }finally{await file.close()}
  const huge=await json('/uploads',{name:'200-gib.bin',directory:'/',size:200*1024**3,lastModified:0,chunkSize:CHUNK_SIZE,hashes:Array(2048).fill(fullHash)})
  assert.equal(huge.status,201,await huge.clone().text())
  const largeSession=await huge.json()
  assert.equal(largeSession.size,214748364800)
  assert.equal(largeSession.totalChunks,2048)
  const cancel=await fetch(url+'/api/uploads/'+largeSession.id,{method:'DELETE',headers:{cookie,'x-filebrowser-request':'1'}})
  assert.equal(cancel.status,200)
})
