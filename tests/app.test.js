import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat, readdir, appendFile, rename, unlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../backend/app.ts'
import { CHUNK_SIZE, FULL_PERMISSIONS, READ_PERMISSIONS } from '../shared/types.ts'
import { uploadingPath } from '../backend/storage/paths.ts'
import { LocalStorage } from '../backend/storage/local.ts'

const digest = data => createHash('sha256').update(data).digest('hex')
const password = 'test-password-with-entropy'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-api-'))
  const options = { storageRoot: join(root,'files'), stateDirectory: join(root,'state') }
  let app = await createApp(options)
  let url = await app.listen({ host:'127.0.0.1',port:0 })
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})})
  let cookie = ''
  async function request(path, method='GET', body, extra={}) {
    const response = await fetch(url+'/api'+path,{method,headers:{'x-filebrowser-request':'1',...(body===undefined?{}:{'content-type':'application/json'}),...(path.startsWith('/files/content')?{connection:'close'}:{}),...(cookie?{cookie}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)})
    return response
  }
  const setup=await request('/setup','POST',{username:'admin',password,siteName:'Test workspace'})
  assert.equal(setup.status,201,await setup.clone().text())
  cookie=setup.headers.get('set-cookie').split(';')[0]
  const user=await setup.json()
  return {root,options,user,request,get url(){return url},get cookie(){return cookie},set cookie(value){cookie=value},async restart(){await app.close();app=await createApp(options);url=await app.listen({host:'127.0.0.1',port:0})}}
}
async function initialize(f, name, data, directory='/') {
  const response=await f.request('/uploads','POST',{name,directory,size:data.length,lastModified:0,chunkSize:CHUNK_SIZE,hashes:data.length?[digest(data)]:[]})
  assert.equal(response.status,201,await response.clone().text())
  return response.json()
}
async function sendChunk(f,session,data,connections=1) {
  const response=await f.request(`/uploads/${session.id}/chunks/0/start`,'POST',{connections})
  assert.equal(response.status,200,await response.clone().text())
  const attempt=await response.json()
  const parts=await Promise.all(attempt.parts.map(p=>fetch(`${f.url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${p.index}`,{method:'PUT',headers:{cookie:f.cookie,'x-filebrowser-request':'1','content-type':'application/octet-stream'},body:data.subarray(p.offset,p.offset+p.size)})))
  for(const part of parts)assert.equal(part.status,204,await part.text())
  return attempt
}

test('setup is one-time; credentials, sessions, CSRF, and instance exclusion are enforced',async t=>{
  const f=await fixture(t)
  assert.equal((await f.request('/setup','POST',{username:'again',password,siteName:'Oops'})).status,409)
  const sessionCookie=f.cookie
  const noHeader=await fetch(f.url+'/api/files/directories',{method:'POST',headers:{cookie:sessionCookie,'content-type':'application/json'},body:JSON.stringify({directory:'/',name:'blocked'})})
  assert.equal(noHeader.status,403)
  assert.equal((await f.request('/files/directories','POST',{directory:'/',name:'blocked'},{origin:'https://attacker.example'})).status,403)
  await assert.rejects(createApp(f.options),/Another Filebrowser process/)
  await assert.rejects(createApp({...f.options,stateDirectory:join(f.root,'other-state')}),/owns this storage root/)
  await f.restart()
  assert.equal((await f.request('/bootstrap')).status,200)
  assert.equal((await (await f.request('/bootstrap')).json()).user.username,'admin')
  await f.request('/auth/logout','POST')
  assert.equal((await f.request('/files')).status,401)
  f.cookie=''
  assert.equal((await f.request('/auth/login','POST',{username:'admin',password:'incorrect'})).status,401)
  const login=await f.request('/auth/login','POST',{username:'ADMIN',password})
  assert.equal(login.status,200)
  f.cookie=login.headers.get('set-cookie').split(';')[0]
  assert.equal((await f.request('/auth/password','POST',{currentPassword:password,newPassword:'changed-password-long-enough'})).status,200)
  assert.equal((await f.request('/files')).status,401)
  const saved=await readFile(join(f.root,'state','filebrowser.sqlite'))
  assert.ok(!saved.includes(Buffer.from(password)))
})

test('scopes, permission changes, symlinks, traversal, and last-admin protections',async t=>{
  const f=await fixture(t)
  await mkdir(join(f.root,'files','team'))
  await writeFile(join(f.root,'files','team','visible.txt'),'team')
  await writeFile(join(f.root,'files','private.txt'),'private')
  await symlink(join(f.root,'files','private.txt'),join(f.root,'files','team','escape.txt'))
  const create=await f.request('/admin/users','POST',{username:'reader',password,role:'user',scope:'/team',permissions:READ_PERMISSIONS})
  assert.equal(create.status,201,await create.clone().text())
  const user=await create.json()
  assert.equal((await f.request('/admin/users','POST',{username:'reader',password,role:'user',scope:'/team',permissions:READ_PERMISSIONS})).status,409)
  const adminCookie=f.cookie
  const login=await f.request('/auth/login','POST',{username:'reader',password})
  f.cookie=login.headers.get('set-cookie').split(';')[0]
  const list=await (await f.request('/files')).json()
  assert.deepEqual(list.entries.map(e=>e.name),['visible.txt'])
  assert.equal(list.entries[0].path,'/visible.txt')
  assert.equal((await f.request('/files?path='+encodeURIComponent('/../'))).status,400)
  assert.equal((await f.request('/files?path='+encodeURIComponent('/.filebrowser-uploads'))).status,400)
  assert.equal((await f.request('/files/content?path=/escape.txt')).status,403)
  assert.equal((await f.request('/files/content?path=/private.txt')).status,404)
  assert.equal((await f.request('/files/directories','POST',{directory:'/',name:'nope'})).status,403)
  assert.equal((await f.request('/admin/users')).status,403)
  const content=await f.request('/files/content?path=/visible.txt','GET',undefined,{range:'bytes=1-2'})
  assert.equal(content.status,206);assert.equal(await content.text(),'ea')
  assert.equal((await f.request('/files/content?path=/visible.txt','GET',undefined,{range:'bytes=4-'})).status,416)
  const readerCookie=f.cookie;f.cookie=adminCookie
  assert.equal((await f.request('/admin/users/'+user.id,'PATCH',{username:'reader',role:'user',scope:'/team',permissions:READ_PERMISSIONS,disabled:true})).status,200)
  f.cookie=readerCookie;assert.equal((await f.request('/files')).status,401);f.cookie=adminCookie
  const demote=await f.request('/admin/users/'+f.user.id,'PATCH',{username:'admin',role:'user',scope:'/',permissions:FULL_PERMISSIONS,disabled:false})
  assert.equal(demote.status,409)
})

test('multi-connection chunks verify, append once, survive lost acknowledgments, and publish without a copy',async t=>{
  const f=await fixture(t)
  const data=Buffer.from('A robust resumable upload across four independent connections.'.repeat(2000))
  const session=await initialize(f,'payload.txt',data)
  const duplicate=await initialize(f,'payload.txt',data)
  assert.equal(duplicate.id,session.id)
  assert.equal((await f.request(`/uploads/${session.id}/chunks/1/start`,'POST',{connections:1})).status,409)
  const attempt=await sendChunk(f,session,data,4)
  const stage=join(f.root,'files','.filebrowser-uploads',session.id)
  assert.equal((await stat(join(stage,'target.uploading'))).size,0)
  const commit=await f.request(`/uploads/${session.id}/chunks/0/commit`,'POST',{attemptId:attempt.id})
  assert.equal(commit.status,200,await commit.clone().text())
  assert.equal((await commit.json()).committedBytes,data.length)
  const inode=(await stat(join(stage,'target.uploading'))).ino
  const repeat=await f.request(`/uploads/${session.id}/chunks/0/commit`,'POST',{attemptId:attempt.id})
  assert.equal(repeat.status,200)
  assert.equal((await stat(join(stage,'target.uploading'))).size,data.length)
  assert.deepEqual(await readdir(stage),['destination.json','target.uploading'])
  await f.restart()
  const saved=await (await f.request(`/uploads/${session.id}`)).json()
  assert.equal(saved.nextChunk,1)
  const done=await f.request(`/uploads/${session.id}/complete`,'POST')
  assert.equal(done.status,200,await done.clone().text())
  assert.equal((await done.json()).status,'completed')
  assert.equal((await stat(join(f.root,'files','payload.txt'))).ino,inode)
  assert.deepEqual(await readFile(join(f.root,'files','payload.txt')),data)
  assert.equal((await f.request(`/uploads/${session.id}/complete`,'POST')).status,200)
  assert.deepEqual(await readdir(join(f.root,'files','.filebrowser-uploads')),[])
  const empty=await initialize(f,'empty.txt',Buffer.alloc(0))
  assert.equal(empty.totalChunks,0)
  assert.equal((await f.request(`/uploads/${empty.id}/complete`,'POST')).status,200)
  assert.equal((await stat(join(f.root,'files','empty.txt'))).size,0)
})

test('bad checksums, incomplete parts, stale attempts, and restart tails roll back the whole chunk',async t=>{
  const f=await fixture(t)
  const data=Buffer.from('This is the correct content.')
  const session=await initialize(f,'recover.txt',data)
  let attempt=await sendChunk(f,session,Buffer.alloc(data.length,1),2)
  const bad=await f.request(`/uploads/${session.id}/chunks/0/commit`,'POST',{attemptId:attempt.id})
  assert.equal(bad.status,422)
  let current=await (await f.request(`/uploads/${session.id}`)).json()
  assert.equal(current.committedBytes,0)
  const stage=join(f.root,'files','.filebrowser-uploads',session.id)
  assert.equal((await stat(join(stage,'target.uploading'))).size,0)
  assert.deepEqual(await readdir(stage),['destination.json','target.uploading'])
  attempt=await (await f.request(`/uploads/${session.id}/chunks/0/start`,'POST',{connections:2})).json()
  const short=await fetch(`${f.url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/0`,{method:'PUT',headers:{cookie:f.cookie,'x-filebrowser-request':'1','content-type':'application/octet-stream'},body:Buffer.from('x')})
  assert.equal(short.status,400)
  assert.equal((await f.request(`/uploads/${session.id}/chunks/0/commit`,'POST',{attemptId:attempt.id})).status,409)
  const old=attempt.id
  await sendChunk(f,session,data,1)
  const stale=await fetch(`${f.url}/api/uploads/${session.id}/attempts/${old}/parts/0`,{method:'PUT',headers:{cookie:f.cookie,'x-filebrowser-request':'1','content-type':'application/octet-stream'},body:data})
  assert.equal(stale.status,409)
  await appendFile(join(stage,'target.uploading'),'uncommitted tail after a simulated crash')
  await f.restart()
  assert.equal((await stat(join(stage,'target.uploading'))).size,0)
  assert.deepEqual(await readdir(stage),['destination.json','target.uploading'])
  current=await (await f.request(`/uploads/${session.id}`)).json()
  assert.equal(current.nextChunk,0)
  attempt=await sendChunk(f,session,data,4)
  assert.equal((await f.request(`/uploads/${session.id}/chunks/0/commit`,'POST',{attemptId:attempt.id})).status,200)
  await writeFile(join(f.root,'files','recover.txt'),'existing file')
  assert.equal((await f.request(`/uploads/${session.id}/complete`,'POST')).status,409)
  assert.equal(await readFile(join(f.root,'files','recover.txt'),'utf8'),'existing file')
  await rm(join(f.root,'files','recover.txt'))
  assert.equal((await f.request(`/uploads/${session.id}/complete`,'POST')).status,200)
  assert.deepEqual(await readFile(join(f.root,'files','recover.txt')),data)
})

test('visible .uploading files share their stage inode, report committed bytes, and cannot be read or mutated',async t=>{
  const f=await fixture(t)
  await mkdir(join(f.root,'files','team'))
  const data=Buffer.from('Verified content for a visible pending file.')
  const session=await initialize(f,'visible.txt',data,'/team')
  const pending=join(f.root,'files','team','visible.txt.uploading')
  const stage=join(f.root,'files','.filebrowser-uploads',session.id,'target.uploading')
  const inode=(await stat(stage)).ino
  assert.equal((await stat(pending)).ino,inode)
  assert.equal((await stat(pending)).size,0)
  await assert.rejects(stat(join(f.root,'files','team','visible.txt')),{code:'ENOENT'})
  let entries=(await(await f.request('/files?path=/team')).json()).entries
  assert.deepEqual(entries.map(e=>[e.name,e.uploading,e.size]),[['visible.txt.uploading',true,0]])
  for(const query of ['','&preview=1'])assert.equal((await f.request('/files/content?path=/team/visible.txt.uploading'+query)).status,409)
  for(const path of ['/team/visible.txt.uploading','/team/visible.txt','/team']) {
    assert.equal((await f.request('/files?path='+encodeURIComponent(path),'DELETE')).status,409)
    assert.equal((await f.request('/files','PATCH',{path,name:'moved'})).status,409)
  }
  assert.equal((await f.request('/files/directories','POST',{directory:'/team',name:'visible.txt.uploading'})).status,409)
  const collision=await f.request('/uploads','POST',{name:'visible.txt.uploading',directory:'/team',size:0,lastModified:0,chunkSize:CHUNK_SIZE,hashes:[]})
  assert.equal(collision.status,409)
  const attempt=await sendChunk(f,session,data,4)
  assert.equal((await stat(pending)).size,0)
  assert.equal((await f.request(`/uploads/${session.id}/chunks/0/commit`,'POST',{attemptId:attempt.id})).status,200)
  assert.deepEqual(await readFile(pending),data)
  // A crash tail must not be advertised as acknowledged upload progress.
  await appendFile(stage,'uncommitted')
  entries=(await(await f.request('/files?path=/team')).json()).entries
  assert.equal(entries[0].size,data.length)
  await f.restart()
  assert.equal((await stat(pending)).size,data.length)
  assert.equal((await f.request(`/uploads/${session.id}/complete`,'POST')).status,200)
  await assert.rejects(stat(pending),{code:'ENOENT'})
  assert.equal((await stat(join(f.root,'files','team','visible.txt'))).ino,inode)
  entries=(await(await f.request('/files?path=/team')).json()).entries
  assert.equal(entries[0].name,'visible.txt');assert.equal(entries[0].uploading,undefined)
  assert.deepEqual(Buffer.from(await(await f.request('/files/content?path=/team/visible.txt')).arrayBuffer()),data)
})

test('suffix collisions preserve unrelated files; canceled transfers release both names without deleting replacements',async t=>{
  const f=await fixture(t)
  const data=Buffer.from('Canceling must retain unrelated host files.')
  const manifest={name:'collision.txt',directory:'/',size:data.length,lastModified:0,chunkSize:CHUNK_SIZE,hashes:[digest(data)]}
  const pending=join(f.root,'files','collision.txt.uploading')
  await writeFile(pending,'existing suffix file')
  assert.equal((await f.request('/uploads','POST',manifest)).status,409)
  assert.equal(await readFile(pending,'utf8'),'existing suffix file')
  await unlink(pending)
  const session=await initialize(f,manifest.name,data)
  await unlink(pending)
  await writeFile(pending,'host replacement')
  assert.equal((await f.request(`/uploads/${session.id}`,'DELETE')).status,200)
  assert.equal(await readFile(pending,'utf8'),'host replacement')
  assert.deepEqual(await readdir(join(f.root,'files','.filebrowser-uploads')),[])
  assert.equal((await f.request('/files/content?path=/collision.txt.uploading')).status,200)
  // Cancel is idempotent, even when that filename has subsequently been reused.
  assert.equal((await f.request(`/uploads/${session.id}`,'DELETE')).status,200)
  assert.equal(await readFile(pending,'utf8'),'host replacement')
  await unlink(pending)
  const next=await initialize(f,manifest.name,data)
  assert.equal((await f.request(`/uploads/${next.id}`,'DELETE')).status,200)
  await assert.rejects(stat(pending),{code:'ENOENT'})
})

test('legacy private targets migrate without copying; a lost public alias is restored on restart',async t=>{
  const f=await fixture(t)
  const data=Buffer.from('Existing transfers retain exactly the same verified bytes.')
  const session=await initialize(f,'legacy.txt',data)
  const attempt=await sendChunk(f,session,data)
  assert.equal((await f.request(`/uploads/${session.id}/chunks/0/commit`,'POST',{attemptId:attempt.id})).status,200)
  const stage=join(f.root,'files','.filebrowser-uploads',session.id)
  const pending=join(f.root,'files','legacy.txt.uploading')
  const inode=(await stat(pending)).ino
  await unlink(pending)
  await unlink(join(stage,'destination.json'))
  await rename(join(stage,'target.uploading'),join(stage,'target'))
  await f.restart()
  assert.equal((await stat(pending)).ino,inode)
  assert.deepEqual(await readFile(pending),data)
  assert.equal((await(await f.request(`/uploads/${session.id}`)).json()).nextChunk,1)
  await unlink(pending)
  await f.restart()
  assert.equal((await stat(pending)).ino,inode)
  assert.equal((await f.request(`/uploads/${session.id}/complete`,'POST')).status,200)
})

test('255-byte Unicode names and completed files ending .uploading remain supported',async t=>{
  const f=await fixture(t)
  const longName='文'.repeat(85)
  const alias=uploadingPath('/'+longName)
  assert.ok(Buffer.byteLength(alias.slice(1))<=255)
  assert.match(alias,/\.uploading$/)
  const session=await initialize(f,longName,Buffer.alloc(0))
  assert.equal((await f.request(`/uploads/${session.id}/complete`,'POST')).status,200)
  assert.equal((await stat(join(f.root,'files',longName))).size,0)
  await assert.rejects(stat(join(f.root,'files',alias)),{code:'ENOENT'})
  const ordinary=await initialize(f,'normal.uploading',Buffer.alloc(0))
  assert.equal((await f.request(`/uploads/${ordinary.id}/complete`,'POST')).status,200)
  const entry=(await(await f.request('/files')).json()).entries.find(e=>e.name==='normal.uploading')
  assert.equal(entry.uploading,undefined)
  assert.equal((await f.request('/files/content?path=/normal.uploading')).status,200)
})

test('orphan cleanup removes abandoned aliases but preserves suffix-named completed files sharing the old inode',async t=>{
  const f=await fixture(t)
  const storage=new LocalStorage(join(f.root,'files'))
  const orphan='aa000000-0000-4000-8000-000000000001'
  const orphanInode=await storage.createStage(orphan,'/orphan.txt')
  await storage.restoreStage(orphan,'/orphan.txt',orphanInode)
  await f.restart()
  await assert.rejects(stat(join(f.root,'files','orphan.txt.uploading')),{code:'ENOENT'})
  const interrupted='aa000000-0000-4000-8000-000000000002'
  await storage.createStage(interrupted,'/never-exposed.txt')
  await writeFile(join(f.root,'files','.filebrowser-uploads',interrupted,'destination.json'),'{"dest')
  await f.restart()
  await assert.rejects(stat(join(f.root,'files','.filebrowser-uploads',interrupted)),{code:'ENOENT'})
  const session=await initialize(f,'finished.txt',Buffer.alloc(0))
  assert.equal((await f.request(`/uploads/${session.id}/complete`,'POST')).status,200)
  // Simulate a completed stage awaiting cleanup and a later user rename.
  const stage=join(f.root,'files','.filebrowser-uploads',session.id)
  await mkdir(stage)
  await link(join(f.root,'files','finished.txt'),join(stage,'target.uploading'))
  await writeFile(join(stage,'destination.json'),JSON.stringify({destination:'/finished.txt'}))
  await rename(join(f.root,'files','finished.txt'),join(f.root,'files','finished.txt.uploading'))
  await f.restart()
  assert.equal((await stat(join(f.root,'files','finished.txt.uploading'))).size,0)
  assert.deepEqual(await readdir(join(f.root,'files','.filebrowser-uploads')),[])
})
