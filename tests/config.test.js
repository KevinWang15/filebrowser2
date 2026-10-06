import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storageLocations, uploadConfig } from '../backend/config.ts'
import { createApp } from '../backend/app.ts'
import { CHUNK_SIZE, MAX_FILE_SIZE } from '../shared/types.ts'

test('whole-filesystem storage requires private state in the reserved namespace',()=>{
  assert.deepEqual(storageLocations('/','/root/filebrowser2/.filebrowser-state'),{storageRoot:'/',stateDirectory:'/root/filebrowser2/.filebrowser-state'})
  assert.throws(()=>storageLocations('/','/root/filebrowser2/state'),/FB_STATE_DIR/)
  assert.throws(()=>storageLocations('/srv/files','/srv/files/state'),/FB_STATE_DIR/)
  assert.throws(()=>storageLocations('/srv/files','/srv/files'),/FB_STATE_DIR/)
  assert.equal(storageLocations('/srv/files','/srv/files-other/state').stateDirectory,'/srv/files-other/state')
})

test('reserved in-root account state cannot be listed or downloaded',async t=>{
  const root=await mkdtemp(join(tmpdir(),'filebrowser-private-state-'))
  const app=await createApp({storageRoot:root,stateDirectory:join(root,'.filebrowser-state')})
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})})
  const url=await app.listen({host:'127.0.0.1',port:0})
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'x-filebrowser-request':'1','content-type':'application/json'},body:JSON.stringify({username:'admin',password:'private-state-test-password',siteName:'Private state'})})
  assert.equal(setup.status,201)
  const cookie=setup.headers.get('set-cookie').split(';')[0]
  const listing=await(await fetch(url+'/api/files',{headers:{cookie}})).json()
  assert.deepEqual(listing.entries,[])
  for(const path of ['/files?path=/.filebrowser-state','/files/content?path=/.filebrowser-state/filebrowser.sqlite']) {
    assert.equal((await fetch(url+'/api'+path,{headers:{cookie}})).status,400)
  }
})

test('runtime chunk overrides are bounded and report a feasible manifest size',()=>{
  assert.deepEqual(uploadConfig(CHUNK_SIZE,MAX_FILE_SIZE),{chunkSize:CHUNK_SIZE,maxFileSize:MAX_FILE_SIZE,maxConnections:4})
  assert.equal(uploadConfig(100*1024).chunkSize,102400)
  assert.equal(uploadConfig(100*1024).maxFileSize,1228800000)
  for(const size of [0,-1,64*1024-1,CHUNK_SIZE+1,NaN,Infinity,1.1])assert.throws(()=>uploadConfig(size),/FB_UPLOAD_CHUNK_SIZE/)
  assert.throws(()=>uploadConfig(102400,MAX_FILE_SIZE),/FB_MAX_FILE_SIZE/)
})

test('an existing upload resumes with its stored chunk size after a runtime configuration change',async t=>{
  const root=await mkdtemp(join(tmpdir(),'filebrowser-config-resume-'))
  const paths={storageRoot:join(root,'files'),stateDirectory:join(root,'state')}
  let app=await createApp({...paths,chunkSize:CHUNK_SIZE})
  let url=await app.listen({host:'127.0.0.1',port:0})
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})})
  let cookie=''
  const request=(path,body)=>fetch(url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'X-Filebrowser-Request':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})
  const setup=await request('/setup',{username:'admin',password:'config-resume-test-password',siteName:'Resume'})
  assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie').split(';')[0]
  const data=Buffer.alloc(128*1024+17,0x47)
  const manifest={name:'original-chunk.bin',directory:'/',size:data.length,lastModified:0,chunkSize:CHUNK_SIZE,hashes:[createHash('sha256').update(data).digest('hex')]}
  const initialized=await request('/uploads',manifest)
  assert.equal(initialized.status,201)
  const session=await initialized.json()
  await app.close()
  app=await createApp({...paths,chunkSize:65536})
  url=await app.listen({host:'127.0.0.1',port:0})
  const bootstrap=await(await request('/bootstrap')).json()
  assert.equal(bootstrap.upload.chunkSize,65536)
  assert.equal((await request('/uploads',{...manifest,name:'new-session.bin'})).status,400)
  const restored=await(await request(`/uploads/${session.id}`)).json()
  assert.equal(restored.chunkSize,CHUNK_SIZE);assert.equal(restored.totalChunks,1)
  const started=await request(`/uploads/${session.id}/chunks/0/start`,{connections:4})
  assert.equal(started.status,200)
  const attempt=await started.json()
  const parts=await Promise.all(attempt.parts.map(part=>fetch(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${part.index}`,{method:'PUT',headers:{cookie,'X-Filebrowser-Request':'1','Content-Type':'application/octet-stream'},body:data.subarray(part.offset,part.offset+part.size)})))
  for(const part of parts)assert.equal(part.status,204)
  const committed=await request(`/uploads/${session.id}/chunks/0/commit`,{attemptId:attempt.id})
  assert.equal(committed.status,200);assert.equal((await committed.json()).committedBytes,data.length)
  assert.equal((await request(`/uploads/${session.id}/complete`,{})).status,200)
  assert.deepEqual(await readFile(join(paths.storageRoot,manifest.name)),data)
})
