import { verificationTargetId, verificationLocalTarget } from './verification-targets.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const url = 'http://diskfull:3000'
const output = process.env.FB_VERIFY_OUTPUT ?? '/evidence'
let targetId = ''
const results = []
await mkdir(output, { recursive: true })
let cookie = ''
function check(name, detail = '') { results.push({ name, status:'PASS', detail }); console.log('PASS ' + name + ': ' + detail) }
async function api(path, data, method) {
  return fetch(url+'/api'+path,{method:method??(data===undefined?'GET':'POST'),headers:{cookie,'X-Filebrowser-Request':'1',...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})})
}
function bytes(index, size) { const data=Buffer.alloc(size,index%251);if(size>=8)data.writeBigUInt64LE(BigInt(index));return data }
async function initialize(name,size) {
  const hashes=[];const expected=createHash('sha256')
  for(let index=0;index<Math.ceil(size/102400);index++){const value=bytes(index,Math.min(102400,size-index*102400));hashes.push(createHash('sha256').update(value).digest('hex'));expected.update(value)}
  const response=await api('/uploads',{targetId, name,directory:'/',size,chunkSize:102400,lastModified:0,hashes})
  assert.equal(response.status,201,await response.clone().text())
  return {session:await response.json(),expectedHash:expected.digest('hex')}
}
async function stage(session) {
  const response=await api(`/uploads/${session.id}/chunks/${session.nextChunk}/start`,{connections:1})
  if(response.status!==200)return {response}
  const attempt=await response.json()
  const value=bytes(session.nextChunk,Math.min(102400,session.size-session.committedBytes))
  const sent=await fetch(`${url}/api/uploads/${session.id}/attempts/${attempt.id}/parts/0`,{method:'PUT',headers:{cookie,'X-Filebrowser-Request':'1','Content-Type':'application/octet-stream'},body:value})
  assert.equal(sent.status,204,await sent.text())
  return {attempt,response}
}
async function commit(session,attempt) { return api(`/uploads/${session.id}/chunks/${session.nextChunk}/commit`,{attemptId:attempt.id}) }

try {
  const setup=await api('/setup',{username:'admin',password:'diskfull-verification-password',siteName:'Disk pressure',target:verificationLocalTarget()})
  assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie').split(';')[0]
  targetId = verificationTargetId(await(await api('/bootstrap')).json())
  const info=await(await api('/system')).json()
  assert.equal(info.targets.find(target=>target.id===targetId).total,32*1024*1024)
  check('disk-constrained production container uses a real 32 MiB tmpfs')
  let filler=(await initialize('space-filler.bin',8*1024*1024)).session
  while(filler.nextChunk<filler.totalChunks){const current=await stage(filler);assert.ok(current.attempt);const response=await commit(filler,current.attempt);assert.equal(response.status,200);filler=await response.json()}
  assert.equal((await api(`/uploads/${filler.id}/complete`,{})).status,200)
  const upload=await initialize('disk-recovery.bin',20*1024*1024)
  let session=upload.session
  let stopped=false
  while(session.nextChunk<session.totalChunks){const current=await stage(session);if(current.response.status===507){stopped=true;break}assert.ok(current.attempt);const response=await commit(session,current.attempt);assert.equal(response.status,200);session=await response.json()}
  assert.equal(stopped,true)
  const saved=await(await api(`/uploads/${session.id}`)).json()
  assert.equal(saved.committedBytes,session.committedBytes)
  check('capacity guard returns 507 and retains committed progress', `${session.committedBytes} bytes`)
  assert.equal((await api(`/targets/${targetId}/files?path=/space-filler.bin`,undefined,'DELETE')).status,200)
  const current=await stage(session)
  assert.ok(current.attempt)
  await writeFile(join(output,'disk-pressure-request.json'),JSON.stringify({id:session.id,committedBytes:session.committedBytes,nextChunk:session.nextChunk},null,2))
  console.log('DISK_PRESSURE_CHECKPOINT '+session.committedBytes)
  const deadline=Date.now()+120000
  while(Date.now()<deadline){try{await access(join(output,'disk-pressure-ready'));break}catch{await delay(200)}}
  await access(join(output,'disk-pressure-ready'))
  const failed=await commit(session,current.attempt)
  assert.equal(failed.status,507,await failed.clone().text())
  const after=await(await api(`/uploads/${session.id}`)).json()
  assert.equal(after.committedBytes,session.committedBytes);assert.equal(after.nextChunk,session.nextChunk)
  check('actual ENOSPC during append rolls back the whole chunk', `offset stays ${after.committedBytes}`)
  assert.equal((await api(`/targets/${targetId}/files?path=/pressure-fixture.bin`,undefined,'DELETE')).status,200)
  while(session.nextChunk<session.totalChunks){const next=await stage(session);assert.ok(next.attempt);const response=await commit(session,next.attempt);assert.equal(response.status,200,await response.clone().text());session=await response.json()}
  assert.equal((await api(`/uploads/${session.id}/complete`,{})).status,200)
  const response=await api(`/targets/${targetId}/files/content?path=/disk-recovery.bin`)
  assert.equal(response.status,200)
  const actual=createHash('sha256');for await(const value of response.body)actual.update(value)
  assert.equal(actual.digest('hex'),upload.expectedHash)
  check('freeing space permits byte-identical resumption and completion', `${session.size} bytes, SHA-256 ${upload.expectedHash}`)
  await writeFile(join(output,'disk-results.json'),JSON.stringify({status:'PASS',results},null,2))
} catch(error) {
  await writeFile(join(output,'disk-results.json'),JSON.stringify({status:'FAIL',error:error.stack,results},null,2));throw error
}
