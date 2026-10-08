import { localTarget, firstTarget } from './fixtures/targets.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serverStorage, uploadConfig } from '../backend/config.ts'
import { createApp } from '../backend/app.ts'
import { CHUNK_SIZE, MAX_FILE_SIZE, READ_PERMISSIONS } from '../shared/types.ts'

test('startup reads state and setup configuration without creating an implicit storage target',()=>{
  assert.deepEqual(serverStorage([],{}),{stateDirectory:'./.filebrowser-state',setupLocalPath:'./data'})
  assert.deepEqual(serverStorage([],{FB_STATE_DIR:'/private',FB_SETUP_LOCAL_PATH:'/suggested'}),{stateDirectory:'/private',setupLocalPath:'/suggested'})
  for(const args of [['/directory'],['--unknown'],['one','two']])assert.throws(()=>serverStorage(args,{}),/not supported/)
})

for (const name of ['state', '.filebrowser-state']) test(`${name}: application state inside a target follows ordinary file permissions and scopes`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'filebrowser-state-access-'))
  const stateDirectory=join(root,name)
  const app=await createApp({stateDirectory})
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})})
  const url=await app.listen({host:'127.0.0.1',port:0})
  const headers={'x-filebrowser-request':'1','content-type':'application/json'}
  const password='state-access-test-password'
  const setup=await fetch(url+'/api/setup',{method:'POST',headers,body:JSON.stringify({username:'admin',password,siteName:'State access',target:localTarget(root)})})
  assert.equal(setup.status,201)
  const cookie=setup.headers.get('set-cookie').split(';')[0]
  const targetId = (await(await fetch(url+'/api/targets',{headers:{cookie}})).json())[0].id
  const listing=await(await fetch(url+`/api/targets/${targetId}/files`,{headers:{cookie}})).json()
  assert.ok(listing.entries.some(entry=>entry.name===name))
  const api=url+`/api/targets/${targetId}/files`
  const download=await fetch(api+'/content?path='+encodeURIComponent(`/${name}/targets.key`),{headers:{cookie}})
  assert.equal(download.status,200)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),await readFile(join(stateDirectory,'targets.key')))
  const create=await fetch(api+'/directories',{method:'POST',headers:{...headers,cookie},body:JSON.stringify({directory:`/${name}`,name:'Notes'})})
  assert.equal(create.status,200)
  await writeFile(join(stateDirectory,'Notes','note.txt'),'ordinary state-directory file')
  assert.equal((await fetch(api,{method:'PATCH',headers:{...headers,cookie},body:JSON.stringify({path:`/${name}/Notes/note.txt`,name:'renamed.txt'})})).status,200)
  assert.equal((await fetch(api+'?path='+encodeURIComponent(`/${name}/Notes`),{method:'DELETE',headers:{'x-filebrowser-request':'1',cookie}})).status,200)
  await mkdir(join(root,'Allowed'))
  const created=await fetch(url+'/api/admin/users',{method:'POST',headers:{...headers,cookie},body:JSON.stringify({username:'member',password,role:'user',grants:[{targetId,scope:`/${name}`,permissions:READ_PERMISSIONS}]})})
  assert.equal(created.status,201)
  const member=await created.json()
  const login=async()=>{
    const response=await fetch(url+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({username:'member',password})})
    assert.equal(response.status,200)
    return response.headers.get('set-cookie').split(';')[0]
  }
  const memberCookie=await login()
  assert.equal((await fetch(api+'/content?path=/filebrowser.sqlite',{method:'HEAD',headers:{cookie:memberCookie}})).status,200)
  assert.equal((await fetch(api+'?path=/Notes',{method:'DELETE',headers:{'x-filebrowser-request':'1',cookie:memberCookie}})).status,403)
  const changed=await fetch(url+'/api/admin/users/'+member.id,{method:'PATCH',headers:{...headers,cookie},body:JSON.stringify({username:'member',role:'user',disabled:false,grants:[{targetId,scope:'/Allowed',permissions:READ_PERMISSIONS}]})})
  assert.equal(changed.status,200)
  assert.equal((await fetch(api+'/content?path='+encodeURIComponent(`/${name}/targets.key`),{method:'HEAD',headers:{cookie:await login()}})).status,404)
})

test('whole-filesystem read-only setup accepts ordinary state paths and exposes them within granted scope',async t=>{
  const root=await mkdtemp(join(tmpdir(),'filebrowser-root-setup-'))
  const stateDirectory=join(root,'state')
  const app=await createApp({stateDirectory,setupLocalPath:'/',setupLocalReadOnly:true})
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})})
  const url=await app.listen({host:'127.0.0.1',port:0})
  const bootstrap=await(await fetch(url+'/api/bootstrap')).json()
  assert.equal(bootstrap.setupLocalReadOnly,true)
  assert.equal(bootstrap.setupLocalPath,'/')
  const setup=await fetch(url+'/api/setup',{method:'POST',headers:{'x-filebrowser-request':'1','content-type':'application/json'},body:JSON.stringify({username:'admin',password:'root-setup-test-password',siteName:'Whole filesystem',target:{...localTarget('/'),readOnly:true}})})
  assert.equal(setup.status,201,await setup.clone().text())
  const cookie=setup.headers.get('set-cookie').split(';')[0]
  const target=(await(await fetch(url+'/api/targets',{headers:{cookie}})).json())[0]
  assert.equal(target.readOnly,true)
  assert.equal((await(await fetch(url+'/api/bootstrap',{headers:{cookie}})).json()).setupLocalReadOnly,false)
  const files=url+`/api/targets/${target.id}/files`
  const listing=await(await fetch(files+'?path='+encodeURIComponent(join(root,'state')),{headers:{cookie}})).json()
  assert.ok(listing.entries.some(entry=>entry.name==='filebrowser.sqlite'))
  assert.equal((await fetch(files+'/content?path='+encodeURIComponent(join(stateDirectory,'filebrowser.sqlite')),{method:'HEAD',headers:{cookie}})).status,200)
})

test('local targets may be the application state directory',async t=>{
  const root=await mkdtemp(join(tmpdir(),'filebrowser-state-target-'))
  const app=await createApp({stateDirectory:root})
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})})
  const url=await app.listen({host:'127.0.0.1',port:0})
  const headers={'x-filebrowser-request':'1','content-type':'application/json'}
  const setup=await fetch(url+'/api/setup',{method:'POST',headers,body:JSON.stringify({username:'admin',password:'state-target-test-password',siteName:'State target',target:{...localTarget(root),readOnly:true}})})
  assert.equal(setup.status,201,await setup.clone().text())
  const cookie=setup.headers.get('set-cookie').split(';')[0]
  const targetId=await firstTarget(async path=>fetch(url+'/api'+path,{headers:{cookie}}))
  assert.equal((await fetch(url+`/api/targets/${targetId}/files/content?path=/targets.key`,{method:'HEAD',headers:{cookie}})).status,200)
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
  let app=await createApp({stateDirectory:paths.stateDirectory,chunkSize:CHUNK_SIZE})
  let url=await app.listen({host:'127.0.0.1',port:0})
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})})
  let cookie=''
  const request=(path,body)=>fetch(url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'X-Filebrowser-Request':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})
  const setup=await request('/setup',{username:'admin',password:'config-resume-test-password',siteName:'Resume',target:localTarget(paths.storageRoot)})
  assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie').split(';')[0]
  const targetId = await firstTarget(request)
  const data=Buffer.alloc(128*1024+17,0x47)
  const manifest={targetId: targetId, name:'original-chunk.bin',directory:'/',size:data.length,lastModified:0,chunkSize:CHUNK_SIZE,hashes:[createHash('sha256').update(data).digest('hex')]}
  const initialized=await request('/uploads',manifest)
  assert.equal(initialized.status,201)
  const session=await initialized.json()
  await app.close()
  app=await createApp({stateDirectory:paths.stateDirectory,chunkSize:65536})
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
