import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const url = process.env.FB_VERIFY_URL ?? 'http://filebrowser.internal:3000'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence'
const results = []
const password = 'matrix-verification-password'
const all = { read:true, download:true, upload:true, create:true, rename:true, delete:true }
const none = Object.fromEntries(Object.keys(all).map(key => [key, false]))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const check = name => { results.push({name,status:'PASS'}); console.log('PASS '+name) }
async function request(path, data, method, cookie='', headers={}) {
  return fetch(url+'/api'+path,{method:method??(data===undefined?'GET':'POST'),headers:{cookie,'X-Filebrowser-Request':'1',...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(15000)})
}
async function json(response, status=200) { const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value }
async function login(username, pass) {
  const response=await request('/auth/login',{username,password:pass})
  assert.equal(response.status,200,await response.clone().text())
  const cookie=response.headers.get('set-cookie')
  assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/)
  const user=await response.json();assert.equal('password_hash' in user,false)
  return cookie.split(';')[0]
}
function manifest(name, bytes, directory='/Permission matrix') { return {name,directory,size:bytes.length,chunkSize:102400,lastModified:0,hashes:bytes.length?[digest(bytes)]:[]} }
async function upload(cookie, name, bytes, directory='/Permission matrix') {
  let session=await json(await request('/uploads',manifest(name,bytes,directory),undefined,cookie),201)
  if(bytes.length) {
    const attempt=await json(await request(`/uploads/${session.id}/chunks/0/start`,{connections:4},undefined,cookie))
    for(const part of attempt.parts) {
      const response=await fetch(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/${part.index}`,{method:'PUT',headers:{cookie,'X-Filebrowser-Request':'1','Content-Type':'application/octet-stream'},body:bytes.subarray(part.offset,part.offset+part.size)})
      assert.equal(response.status,204,await response.text())
    }
    session=await json(await request(`/uploads/${session.id}/chunks/0/commit`,{attemptId:attempt.id},undefined,cookie))
  }
  return json(await request(`/uploads/${session.id}/complete`,{},undefined,cookie))
}

await mkdir(output,{recursive:true})
try {
  const admin=await login('admin','container-verification-password')
  check('HttpOnly, SameSite cookie and public account without password hash')
  assert.equal((await request('/admin/users')).status,401)
  assert.equal((await request('/files/directories',{directory:'/',name:'csrf-blocked'},undefined,admin,{Origin:'https://foreign.invalid'})).status,403)
  assert.equal((await fetch(url+'/api/files/directories',{method:'POST',headers:{cookie:admin,'Content-Type':'application/json'},body:JSON.stringify({directory:'/',name:'csrf-blocked'})})).status,403)
  check('anonymous access, foreign origins, and missing CSRF header rejected')
  await json(await request('/files/directories',{directory:'/',name:'Permission matrix'},undefined,admin))
  const seed=Buffer.from('Permission boundaries are enforced by the server.\n')
  await upload(admin,'seed.txt',seed)
  await upload(admin,'unsafe.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
  await upload(admin,'empty.txt',Buffer.alloc(0))
  const empty=await request('/files/content?path='+encodeURIComponent('/Permission matrix/empty.txt'),undefined,undefined,admin)
  assert.equal(empty.status,200);assert.equal((await empty.arrayBuffer()).byteLength,0)
  assert.equal((await request('/files/content?path='+encodeURIComponent('/Permission matrix/unsafe.svg')+'&preview=1',undefined,undefined,admin)).status,400)
  const attachment=await request('/files/content?path='+encodeURIComponent('/Permission matrix/unsafe.svg'),undefined,undefined,admin)
  assert.equal(attachment.status,200);assert.match(attachment.headers.get('content-disposition'),/^attachment/);assert.match(attachment.headers.get('content-security-policy'),/sandbox/)
  check('empty files publish correctly and unsafe markup downloads as sandboxed attachments')
  const suffix=await request('/files/content?path='+encodeURIComponent('/Permission matrix/seed.txt'),undefined,undefined,admin,{Range:'bytes=-5'})
  assert.equal(suffix.status,206);assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),seed.subarray(-5))
  for(const range of ['bytes=999999-','bytes=5-1','bytes=0-1,3-4','bytes=-0'])assert.equal((await request('/files/content?path='+encodeURIComponent('/Permission matrix/seed.txt'),undefined,undefined,admin,{Range:range})).status,416)
  check('suffix byte range is correct; invalid, multipart, and empty ranges return 416')
  assert.equal((await request('/files',{path:'/',name:'blocked'},'PATCH',admin)).status,400)
  assert.equal((await request('/files?path=/',undefined,'DELETE',admin)).status,400)
  assert.equal((await request('/uploads',{...manifest('invalid.txt',seed),size:-1},undefined,admin)).status,400)
  assert.equal((await request('/uploads',{...manifest('invalid.txt',seed),chunkSize:104857600},undefined,admin)).status,400)
  check('root mutations and malformed manifests rejected')

  const pending=await json(await request('/uploads',manifest('pending.txt',seed),undefined,admin),201)
  assert.equal((await request(`/uploads/${pending.id}/complete`,{},undefined,admin)).status,409)
  assert.equal((await request(`/uploads/${pending.id}/chunks/0/start`,{connections:3},undefined,admin)).status,400)
  assert.equal((await request('/files',{path:'/Permission matrix',name:'moved'},'PATCH',admin)).status,409)
  assert.equal((await request('/files?path='+encodeURIComponent('/Permission matrix'),undefined,'DELETE',admin)).status,409)
  const attempt=await json(await request(`/uploads/${pending.id}/chunks/0/start`,{connections:2},undefined,admin))
  assert.equal((await request(`/uploads/${pending.id}/chunks/0/commit`,{attemptId:attempt.id},undefined,admin)).status,409)
  check('incomplete publication/commit and ancestor rename/deletion cannot bypass an active transfer')

  const account={username:'matrix-user',password,role:'user',scope:'/Permission matrix',permissions:none,disabled:false}
  const user=await json(await request('/admin/users',account,undefined,admin),201)
  assert.equal((await request('/admin/users',account,undefined,admin)).status,409)
  let member=await login('matrix-user',password)
  const denies=[['/files',undefined],['/files/content?path=/seed.txt',undefined],['/uploads',manifest('denied.txt',seed,'/')],['/files/directories',{directory:'/',name:'denied'}],['/files',{path:'/seed.txt',name:'denied.txt'},'PATCH'],['/files?path=/seed.txt',undefined,'DELETE']]
  for(const [path,data,method] of denies)assert.equal((await request(path,data,method,member)).status,403)
  for(const path of ['/admin/users','/admin/audit'])assert.equal((await request(path,undefined,undefined,member)).status,403)
  assert.equal((await request(`/uploads/${pending.id}`,undefined,undefined,member)).status,404)
  assert.equal((await request(`/uploads/${pending.id}`,undefined,'DELETE',member)).status,404)
  check('all six denied permissions, administration, and other-user sessions are enforced by the API')
  await json(await request(`/uploads/${pending.id}`,undefined,'DELETE',admin))
  await assert.rejects(access(join('/verify-files','.filebrowser-uploads',pending.id)),{code:'ENOENT'})
  assert.equal((await request(`/uploads/${pending.id}/chunks/0/start`,{connections:1},undefined,admin)).status,409)
  check('cancellation removes staging, fences old attempts, and preserves unrelated files')

  for(const permission of Object.keys(all)) {
    const permissions={...none,[permission]:true}
    await json(await request('/admin/users/'+user.id,{...account,password:undefined,permissions},'PATCH',admin))
    assert.equal((await request('/system',undefined,undefined,member)).status,401)
    member=await login('matrix-user',password)
    if(permission==='read') {
      const listing=await json(await request('/files',undefined,undefined,member))
      assert.deepEqual(listing.entries.map(entry=>entry.name).sort(),['empty.txt','seed.txt','unsafe.svg'])
      assert.equal((await request('/files/content?path=/seed.txt&preview=1',undefined,undefined,member)).status,200)
      assert.equal((await request('/files/content?path=/seed.txt',undefined,undefined,member)).status,403)
      assert.equal((await request('/files?path='+encodeURIComponent('/../'),undefined,undefined,member)).status,400)
    } else if(permission==='download') {
      const downloaded=await request('/files/content?path=/seed.txt',undefined,undefined,member)
      assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),seed)
      assert.equal((await request('/files',undefined,undefined,member)).status,403)
      assert.equal((await request('/files/content?path=/seed.txt&preview=1',undefined,undefined,member)).status,403)
    } else if(permission==='upload') {
      const completed=await upload(member,'upload-only.txt',seed,'/')
      assert.equal(completed.status,'completed')
      assert.equal((await request('/files',undefined,undefined,member)).status,403)
      assert.equal((await request('/uploads',manifest('seed.txt',seed,'/'),undefined,member)).status,409)
    } else if(permission==='create') {
      await json(await request('/files/directories',{directory:'/',name:'create-only'},undefined,member))
      assert.equal((await request('/files?path=/create-only',undefined,'DELETE',member)).status,403)
    } else if(permission==='rename') {
      await json(await request('/files',{path:'/seed.txt',name:'renamed.txt'},'PATCH',member))
      assert.equal((await request('/files?path=/renamed.txt',undefined,'DELETE',member)).status,403)
    } else {
      await json(await request('/files?path=/renamed.txt',undefined,'DELETE',member))
      await json(await request('/files?path=/create-only',undefined,'DELETE',member))
      assert.equal((await request('/files/directories',{directory:'/',name:'forbidden'},undefined,member)).status,403)
    }
    check(`granting only ${permission} enables that action; every access change revokes old sessions`)
  }
  const changed='reset-matrix-verification-password'
  await json(await request('/admin/users/'+user.id,{...account,password:changed,permissions:all},'PATCH',admin))
  assert.equal((await request('/system',undefined,undefined,member)).status,401)
  assert.equal((await request('/auth/login',{username:'matrix-user',password})).status,401)
  member=await login('matrix-user',changed)
  await json(await request('/admin/users/'+user.id,{...account,password:undefined,permissions:all,disabled:true},'PATCH',admin))
  assert.equal((await request('/system',undefined,undefined,member)).status,401)
  assert.equal((await request('/auth/login',{username:'matrix-user',password:changed})).status,401)
  check('administrator password reset and disable revoke sessions and reject old credentials')
  for(const file of ['unsafe.svg','empty.txt','upload-only.txt'])await json(await request('/files?path='+encodeURIComponent('/Permission matrix/'+file),undefined,'DELETE',admin))
  await json(await request('/files?path='+encodeURIComponent('/Permission matrix'),undefined,'DELETE',admin))
  const audit=await json(await request('/admin/audit',undefined,undefined,admin))
  assert.ok(audit.some(event=>event.action==='user.updated'));assert.ok(audit.some(event=>event.action==='upload.completed'))
  check('audit records persisted account changes and completed uploads; fixtures cleaned')
  await writeFile(join(output,'api-results.json'),JSON.stringify({status:'PASS',results},null,2))
} catch(error) {
  await writeFile(join(output,'api-results.json'),JSON.stringify({status:'FAIL',error:error.stack,results},null,2));throw error
}
