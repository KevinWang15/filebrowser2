import { localTarget, firstTarget } from './fixtures/targets.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readdir, readlink, rm, symlink, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { extract } from 'tar-stream'
import { createApp } from '../backend/app.ts'
import { Archives, ArchiveResources } from '../backend/archives.ts'
import { LocalStorage } from '../backend/storage/local.ts'
import { FULL_PERMISSIONS, READ_PERMISSIONS, CHUNK_SIZE } from '../shared/types.ts'

const password='archive-fixture-password'
async function fixture(t,readOnly=false) {
  const root=await mkdtemp(join(tmpdir(),'filebrowser-archives-'))
  const options={storageRoot:join(root,'files'),stateDirectory:join(root,'state'),readOnly}
  await mkdir(join(options.storageRoot,'team','empty'),{recursive:true})
  await mkdir(join(options.storageRoot,'other'),{recursive:true})
  await writeFile(join(options.storageRoot,'team','notes #1.txt'),'archive text\n')
  await writeFile(join(options.storageRoot,'team','binary.bin'),Buffer.from([0,1,255,128,5]))
  await writeFile(join(options.storageRoot,'team','.visible'),'ordinary dotfile')
  await writeFile(join(options.storageRoot,'team','ordinary.uploading'),'not a managed upload')
  await writeFile(join(options.storageRoot,'team','文件'.repeat(40)+'.txt'),'long unicode name')
  await writeFile(join(options.storageRoot,'other','notes #1.txt'),'other folder')
  await writeFile(join(options.storageRoot,'private.txt'),'outside scope')
  await mkdir(join(options.storageRoot,'team','.filebrowser-state'))
  await writeFile(join(options.storageRoot,'team','.filebrowser-state','secret'),'secret')
  await symlink(join(options.storageRoot,'private.txt'),join(options.storageRoot,'team','escape.txt'))
  await promisify(execFile)('mkfifo',[join(options.storageRoot,'team','pipe')])
  let app=await createApp({stateDirectory:options.stateDirectory,chunkSize:options.chunkSize,smbEnabled:options.smbEnabled}), url=await app.listen({host:'127.0.0.1',port:0}), cookie=''
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true})})
  const request=(path,method='GET',body,headers={})=>fetch(url+'/api'+path,{method,headers:{cookie,'x-filebrowser-request':'1',...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})})
  const setup=await request('/setup','POST',{username:'admin',password,siteName:'Archive fixtures',target:localTarget(options.storageRoot,readOnly)})
  assert.equal(setup.status,201,await setup.clone().text());cookie=setup.headers.get('set-cookie').split(';')[0]
  const targetId = await firstTarget(request)
  return {root,options,targetId,request,get cookie(){return cookie},set cookie(value){cookie=value},async restart(readOnly){const target = await (await request('/admin/targets')).json();const configuration = target[0];const changed = await request('/admin/targets/'+targetId,'PATCH',{name:configuration.name,connection:configuration.connection,enabled:true,readOnly});assert.equal(changed.status,200,await changed.text());await app.close();app=await createApp({stateDirectory:options.stateDirectory});url=await app.listen({host:'127.0.0.1',port:0})}}
}

export async function unpack(response) {
  const archive=extract(), result=new Map()
  const reading=(async()=>{for await(const entry of archive){const chunks=[];for await(const chunk of entry)chunks.push(chunk);result.set(entry.header.name,{type:entry.header.type,bytes:Buffer.concat(chunks)})}})()
  archive.end(Buffer.from(await response.arrayBuffer()))
  await reading
  return result
}

test('streamed folder tar includes binary, Unicode, empty directories, and excludes private and unfinished files',async t=>{
  const f=await fixture(t)
  const bytes=Buffer.from('pending')
  const init=await f.request('/uploads','POST',{targetId: f.targetId, name:'pending.bin',directory:'/team',size:bytes.length,lastModified:0,chunkSize:CHUNK_SIZE,hashes:[createHash('sha256').update(bytes).digest('hex')]})
  assert.equal(init.status,201)
  const response=await f.request(`/targets/${f.targetId}/files/archive?path=/team`)
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/x-tar')
  assert.equal(response.headers.get('content-length'),null);assert.equal(response.headers.get('accept-ranges'),'none')
  const entries=await unpack(response)
  assert.deepEqual([...entries.keys()].sort(),['.visible','binary.bin','empty/','notes #1.txt','ordinary.uploading','文件'.repeat(40)+'.txt'].sort())
  assert.equal(entries.get('empty/').type,'directory')
  assert.deepEqual(entries.get('binary.bin').bytes,Buffer.from([0,1,255,128,5]))
  assert.equal(entries.get('notes #1.txt').bytes.toString(),'archive text\n')
  assert.equal((await f.request(`/targets/${f.targetId}/files/archive?path=/team`, 'GET',undefined,{range:'bytes=0-20'})).status,416)
  assert.equal((await f.request(`/targets/${f.targetId}/files/archive?path=/team/binary.bin`)).status,400)
  assert.equal((await f.request(`/targets/${f.targetId}/files/archive?path=/../`)).status,400)
  assert.equal((await f.request(`/targets/${f.targetId}/files/archive?path=/.filebrowser-uploads`)).status,400)
  assert.equal((await f.request(`/targets/${f.targetId}/files/archive?path=/team/escape.txt`)).status,403)
  assert.equal((await f.request(`/targets/${f.targetId}/files/archive-tickets`,'POST',{paths:['/team/pipe']})).status,400)
  assert.equal((await f.request(`/targets/${f.targetId}/files/archive-tickets`,'POST',{paths:['/team/pending.bin.uploading']})).status,409)
})

test('mixed selection tickets preserve relative paths, deduplicate subtrees, enforce scope and permissions, and are single-use',async t=>{
  const f=await fixture(t)
  const issue=paths=>f.request(`/targets/${f.targetId}/files/archive-tickets`,'POST',{paths})
  const ticket=await(await issue(['/team','/team/binary.bin','/other/notes #1.txt','/team'])).json()
  const head=await f.request(ticket.url.slice(4),'HEAD');assert.equal(head.status,200);assert.equal(await head.text(),'')
  assert.equal(head.headers.get('content-type'),'application/x-tar');assert.equal(head.headers.get('content-length'),null)
  const response=await f.request(ticket.url.slice(4))
  assert.equal(response.status,200)
  const entries=await unpack(response)
  assert.equal(entries.get('other/notes #1.txt').bytes.toString(),'other folder')
  assert.equal(entries.get('team/notes #1.txt').bytes.toString(),'archive text\n')
  assert.ok(entries.has('team/empty/'));assert.ok(entries.has('team/'))
  assert.equal((await f.request(ticket.url.slice(4))).status,404)
  const racing=await(await issue(['/team'])).json()
  const raced=await Promise.all([f.request(racing.url.slice(4)),f.request(racing.url.slice(4))])
  assert.deepEqual(raced.map(response=>response.status).sort(),[200,404])
  await Promise.all(raced.map(response=>response.arrayBuffer()))
  const created=await f.request('/admin/users','POST',{username:'reader',password,role:'user',grants: [{ targetId: f.targetId, scope: '/team', permissions: READ_PERMISSIONS }]})
  const member=await created.json(),adminCookie=f.cookie
  const adminTicket=await(await issue(['/team'])).json()
  const login=await f.request('/auth/login','POST',{username:'reader',password});f.cookie=login.headers.get('set-cookie').split(';')[0]
  assert.equal((await f.request(adminTicket.url.slice(4))).status,404)
  const scoped=await f.request(`/targets/${f.targetId}/files/archive?path=/`)
  const scopedEntries=await unpack(scoped)
  assert.ok(scopedEntries.has('binary.bin'));assert.ok(!scopedEntries.has('private.txt'))
  assert.equal((await issue(['/private.txt'])).status,404)
  const memberTicket=await(await issue(['/'])).json()
  f.cookie=adminCookie
  assert.equal((await f.request('/admin/users/'+member.id,'PATCH',{...member,grants:[{targetId:f.targetId,scope:'/other',permissions:READ_PERMISSIONS}],id:undefined,createdAt:undefined})).status,200)
  const newLogin=await f.request('/auth/login','POST',{username:'reader',password});f.cookie=newLogin.headers.get('set-cookie').split(';')[0]
  assert.equal((await f.request(memberTicket.url.slice(4))).status,403)
  f.cookie=adminCookie
  assert.equal((await f.request('/admin/users/'+member.id,'PATCH',{...member,id:undefined,createdAt:undefined,grants:[{targetId:f.targetId,scope:'/other',permissions:{...READ_PERMISSIONS,download:false}}]})).status,200)
  const noDownload=await f.request('/auth/login','POST',{username:'reader',password});f.cookie=noDownload.headers.get('set-cookie').split(';')[0]
  assert.equal((await f.request(`/targets/${f.targetId}/files/archive?path=/`)).status,403)
  assert.equal((await issue(['/'])).status,403)
  f.cookie='';assert.equal((await f.request(`/targets/${f.targetId}/files/archive?path=/`)).status,401)
})

test('read-only mode writes no storage metadata, blocks all file mutations even for admin, and still serves archives and account administration',async t=>{
  const f=await fixture(t,true)
  assert.deepEqual((await readdir(f.options.storageRoot)).sort(),['other','private.txt','team'])
  const user=(await(await f.request('/bootstrap')).json()).user
  assert.equal((await(await f.request('/targets')).json())[0].readOnly,true);assert.equal(user.role,'admin')
  for(const [path,method,body] of [
    [`/targets/${f.targetId}/files/directories`,'POST',{directory:'/',name:'blocked'}],
    [`/targets/${f.targetId}/files`,'PATCH',{path:'/private.txt',name:'renamed.txt'}],
    [`/targets/${f.targetId}/files`,'DELETE',{path:'/private.txt'}],

  ]) {const response=await f.request(path,method,body);assert.equal(response.status,403);assert.equal((await response.json()).code,'STORAGE_READ_ONLY')}
  assert.equal((await f.request('/admin/users','POST',{username:'member',password,role:'user',grants: [{ targetId: f.targetId, scope: '/team', permissions: FULL_PERMISSIONS }]})).status,201)
  const ticket=await(await f.request(`/targets/${f.targetId}/files/archive-tickets`,'POST',{paths:['/team']})).json()
  assert.ok((await unpack(await f.request(ticket.url.slice(4)))).has('binary.bin'))
  const range=await f.request(`/targets/${f.targetId}/files/content?path=/team/binary.bin`,'GET',undefined,{range:'bytes=1-3'})
  assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),Buffer.from([1,255,128]))
  const storage=new LocalStorage(f.options.storageRoot,undefined,true)
  await storage.init();await storage.lock()
  await assert.rejects(storage.mkdir('/blocked'),error=>error.code==='STORAGE_READ_ONLY')
  await assert.rejects(storage.createStage('invalid','/blocked'),error=>error.code==='STORAGE_READ_ONLY')
  assert.deepEqual((await readdir(f.options.storageRoot)).sort(),['other','private.txt','team'])
})

test('read-only restart preserves partial uploads for a later writable restart',async t=>{
  const f=await fixture(t),data=Buffer.from('saved upload')
  const created=await f.request('/uploads','POST',{targetId: f.targetId, name:'resume.bin',directory:'/team',size:data.length,lastModified:0,chunkSize:CHUNK_SIZE,hashes:[createHash('sha256').update(data).digest('hex')]})
  const session=await created.json()
  await f.restart(true)
  assert.equal((await f.request('/uploads/'+session.id)).status,200)
  assert.ok(!(await unpack(await f.request(`/targets/${f.targetId}/files/archive?path=/team`))).has('resume.bin.uploading'))
  await f.restart(false)
  const start=await(await f.request(`/uploads/${session.id}/chunks/0/start`,'POST',{connections:1})).json()
  const part=await f.request(`/uploads/${session.id}/attempts/${start.id}/parts/0`,'PUT',undefined,{'content-type':'application/octet-stream'})
  // An empty part is rolled back; the retained session and inode remain intact.
  assert.equal(part.status,400)
  const retained=await(await f.request('/uploads/'+session.id)).json()
  assert.equal(retained.nextChunk,0);assert.equal(retained.id,session.id)
})

test('200 GiB archive metadata, backpressure, source aborts, slot release and bounded ticket expiry',async t=>{
  const user={id:'fixture',scope:'/',role:'admin',permissions:FULL_PERMISSIONS}
  const entry={name:'large.bin',path:'/large.bin',kind:'file',size:200*1024*1024*1024,modifiedAt:new Date().toISOString()}
  let generated=0,closed=0,clock=0
  const storage={stat:async()=>entry,open:async()=>new Readable({read(){generated+=65536;this.push(Buffer.alloc(65536))},destroy(error,done){closed++;done(error)}})}
  const service=new Archives(storage,()=>false,()=>clock)
  t.after(()=>service.close())
  const archive=await service.prepare(user,['/large.bin'])
  const a=service.stream(user,archive),b=service.stream(user,archive)
  assert.throws(()=>service.stream(user,archive),error=>error.statusCode===429)
  await delay(30)
  assert.ok(generated<1024*1024,`Buffered ${generated} bytes without a consumer`)
  const decoder=extract();decoder.on('error',()=>{})
  const decoded=new Promise(resolve=>decoder.once('entry',header=>resolve(header)))
  const header=await new Promise(resolve=>a.once('data',chunk=>{a.pause();resolve(chunk)}))
  decoder.write(header)
  assert.equal((await decoded).size,entry.size);decoder.destroy()
  const aClosed=once(a,'close'),bClosed=once(b,'close');a.destroy();b.destroy();await Promise.all([aClosed,bClosed])
  for(let n=0;n<50&&closed<2;n++)await delay(10)
  assert.equal(closed,2)
  const next=service.stream(user,archive);const nextClosed=once(next,'close');next.destroy();await nextClosed
  const ticket=await service.ticket(user,['/large.bin']);clock=120_001
  await assert.rejects(service.fromTicket(user,ticket.url.split('/').pop()),error=>error.statusCode===404)
  for(let n=0;n<8;n++)await service.ticket(user,['/large.bin'])
  await assert.rejects(service.ticket(user,['/large.bin']),error=>error.statusCode===429)
})

test('disconnecting a native archive download does not leave open files or prevent another download',{timeout:15000},async t=>{
  const f=await fixture(t)
  await mkdir(join(f.options.storageRoot,'large'))
  const file=await open(join(f.options.storageRoot,'large','large.bin'),'w');await file.truncate(128*1024*1024);await file.close()
  for(let n=0;n<4;n++) {
    const controller=new AbortController()
    const response=await f.request(`/targets/${f.targetId}/files/archive?path=/team`)
    await response.arrayBuffer()
    const url=new URL(response.url);url.search='?path=/large'
    const large=await fetch(url,{headers:{cookie:f.cookie},signal:controller.signal})
    await large.body.getReader().read();controller.abort();await delay(50)
    const descriptors=await Promise.all((await readdir('/proc/self/fd')).map(id=>readlink('/proc/self/fd/'+id).catch(()=>'')))
    assert.ok(!descriptors.some(path=>path.startsWith(join(f.options.storageRoot,'large'))),'Archive file or directory descriptor leaked after disconnect')
  }
  const final=await f.request(`/targets/${f.targetId}/files/archive?path=/team`);assert.equal(final.status,200);await final.arrayBuffer()
})

test('a file changing size fails the archive stream instead of silently producing a corrupt archive',async t=>{
  const user={id:'fixture',scope:'/',role:'admin',permissions:FULL_PERMISSIONS}
  const storage={stat:async()=>({name:'changing.bin',path:'/changing.bin',kind:'file',size:100,modifiedAt:new Date().toISOString()}),open:async()=>Readable.from([Buffer.alloc(50)])}
  const service=new Archives(storage,()=>false);t.after(()=>service.close())
  const stream=service.stream(user,await service.prepare(user,['/changing.bin']))
  await assert.rejects(async()=>{for await(const chunk of stream)assert.ok(chunk.length>0)},/Size mismatch/)
})

test('archive budgets span targets; tickets and shutdown retain their target ownership', async t => {
  const resources = new ArchiveResources()
  let clock = 0
  const entry = { name: 'large.bin', path: '/large.bin', kind: 'file', size: 200 * 1024 * 1024 * 1024, modifiedAt: new Date().toISOString() }
  const storage = { stat: async () => entry, open: async () => new Readable({ read() { this.push(Buffer.alloc(65536)) } }) }
  const a = new Archives(storage, () => false, () => clock, user => user, resources)
  const b = new Archives(storage, () => false, () => clock, user => user, resources)
  t.after(() => { a.close(); b.close() })
  const user = { id: 'reader', role: 'admin', scope: '/', permissions: FULL_PERMISSIONS }
  const ua = { ...user, targetId: 'target-a' }, ub = { ...user, targetId: 'target-b' }
  const id = ticket => ticket.url.split('/').at(-1)
  const first = await a.ticket(ua, ['/large.bin'])
  for (let index = 1; index < 8; index++) await (index % 2 ? b.ticket(ub, ['/large.bin']) : a.ticket(ua, ['/large.bin']))
  await assert.rejects(b.ticket(ub, ['/large.bin']), error => error.statusCode === 429)
  await assert.rejects(b.fromTicket(ub, id(first)), error => error.statusCode === 404)
  clock = 120001
  const retained = await b.ticket(ub, ['/large.bin'])
  const activeA = a.stream(ua, await a.prepare(ua, ['/large.bin']))
  const activeB = b.stream(ub, await b.prepare(ub, ['/large.bin']))
  assert.throws(() => a.stream(ua, { selections: [] }), error => error.statusCode === 429)
  for (let index = 0; index < 6; index++) {
    const owner = index % 2 ? a : b, viewer = { ...(index % 2 ? ua : ub), id: 'other-' + index }
    owner.stream(viewer, await owner.prepare(viewer, ['/large.bin']))
  }
  assert.throws(() => b.stream({ ...ub, id: 'overflow' }, { selections: [] }), error => error.statusCode === 429)
  const closed = once(activeA, 'close')
  a.close(); await closed
  assert.equal(activeA.destroyed, true)
  assert.equal(activeB.destroyed, false)
  assert.equal((await b.fromTicket(ub, id(retained), true)).name, 'large.bin.tar')
  const replacement = { ...ub, id: 'replacement' }
  b.stream(replacement, await b.prepare(replacement, ['/large.bin']))
})
