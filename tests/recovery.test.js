import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, truncate, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createApp } from '../backend/app.ts'

test('missing committed bytes fail visibly; canceled attempts release their reservation',async t=>{
  const root=await mkdtemp(join(tmpdir(),'filebrowser-loss-'))
  const options={storageRoot:join(root,'files'),stateDirectory:join(root,'state'),chunkSize:102400}
  let app=await createApp(options)
  let url=await app.listen({host:'127.0.0.1',port:0})
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})})
  let cookie=''
  const request=async(path,body,method)=>fetch(url+'/api'+path,{method:method??(body===undefined?'GET':'POST'),headers:{cookie,'x-filebrowser-request':'1',...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)})
  const setup=await request('/setup',{username:'admin',password:'data-loss-test-password',siteName:'Recovery'})
  cookie=setup.headers.get('set-cookie').split(';')[0]
  const data=Buffer.from('Durable data must never be silently skipped.')
  const manifest={name:'lost.txt',directory:'/',size:data.length,lastModified:0,chunkSize:102400,hashes:[createHash('sha256').update(data).digest('hex')]}
  const session=await(await request('/uploads',manifest)).json()
  const attempt=await(await request(`/uploads/${session.id}/chunks/0/start`,{connections:1})).json()
  const sent=await fetch(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/0`,{method:'PUT',headers:{cookie,'x-filebrowser-request':'1','content-type':'application/octet-stream'},body:data})
  assert.equal(sent.status,204)
  assert.equal((await request(`/uploads/${session.id}/chunks/0/commit`,{attemptId:attempt.id})).status,200)
  await app.close()
  await truncate(join(root,'files','.filebrowser-uploads',session.id,'target.uploading'),4)
  app=await createApp(options);url=await app.listen({host:'127.0.0.1',port:0})
  const saved=await(await request(`/uploads/${session.id}`)).json()
  assert.equal(saved.status,'failed')
  assert.match(saved.error,/Committed data is missing/)
  assert.equal((await request(`/uploads/${session.id}/complete`,{})).status,409)
  assert.equal((await request(`/uploads/${session.id}`,undefined,'DELETE')).status,200)
  assert.deepEqual(await readdir(join(root,'files','.filebrowser-uploads')),[])
  const replacement=await request('/uploads',manifest)
  assert.equal(replacement.status,201)
  assert.notEqual((await replacement.json()).id,session.id)
})
