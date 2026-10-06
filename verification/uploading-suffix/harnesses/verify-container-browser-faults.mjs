/* global window */
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'

const url=process.env.FB_VERIFY_URL??'http://filebrowser.internal:3000'
const output=process.env.FB_VERIFY_OUTPUT??'/evidence'
const results=[]
const errors=[]
const browser=await chromium.launch({executablePath:process.env.FB_CHROMIUM_PATH,args:['--no-sandbox']})
const context=await browser.newContext({viewport:{width:1440,height:980}})
const page=await context.newPage()
page.on('pageerror',error=>errors.push(error.message))
await page.addInitScript(()=>{
  window.__filebrowserHashCount=0
  const OriginalWorker=window.Worker
  window.Worker=class extends OriginalWorker { constructor(...args){super(...args);window.__filebrowserHashCount++} }
})
const bytes=Buffer.alloc(2*1024*1024+79)
for(let index=0;index<bytes.length;index++)bytes[index]=(index*17+Math.floor(index/102400))%251
const expected=createHash('sha256').update(bytes).digest('hex')
const check=name=>{results.push({name,status:'PASS'});console.log('PASS '+name)}
async function add(name) {
  await page.getByRole('button',{name:'New upload',exact:true}).click()
  await page.getByLabel('Connections per chunk').selectOption('4')
  await page.locator('input[type=file][multiple]').setInputFiles({name,mimeType:'application/octet-stream',buffer:bytes})
  return page.locator('.transfer-row').filter({hasText:name})
}
async function complete(row,name) {
  await row.getByText('Complete',{exact:true}).waitFor({timeout:60000})
  const downloaded=await context.request.get(url+'/api/files/content?path='+encodeURIComponent('/'+name))
  assert.equal(downloaded.status(),200)
  const actual=await downloaded.body()
  assert.equal(actual.length,bytes.length)
  assert.equal(createHash('sha256').update(actual).digest('hex'),expected)
}
async function shot(name){await page.screenshot({path:join(output,'screenshots',name+'.png'),fullPage:true})}
try {
  await mkdir(join(output,'screenshots'),{recursive:true})
  await page.goto(url)
  await page.getByLabel('Username',{exact:true}).fill('admin')
  await page.getByLabel('Password',{exact:true}).fill(process.env.FB_VERIFY_ADMIN_PASSWORD??'changed-container-verification-password')
  await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await page.getByRole('heading',{name:'All files.'}).waitFor()
  await page.getByRole('button',{name:'Transfers',exact:true}).click()

  let lostCommit
  await page.route('**/api/uploads/*/chunks/4/commit',async route=>{
    const response=await route.fetch()
    assert.equal(response.status(),200)
    lostCommit=await response.json()
    await route.abort('connectionreset')
  })
  let row=await add('lost-ack.bin')
  await row.locator('.state-retrying').waitFor()
  assert.equal(lostCommit.nextChunk,5);assert.equal(lostCommit.committedBytes,512000)
  await shot('21-lost-acknowledgment-recovery')
  await complete(row,'lost-ack.bin')
  await page.unroute('**/api/uploads/*/chunks/4/commit')
  check('browser loses a real successful commit response, queries the saved offset, and completes without duplicate bytes')

  let corrupted=false
  await page.route('**/api/uploads/*/attempts/*/parts/1',async route=>{
    if(corrupted)return route.continue()
    corrupted=true
    const body=route.request().postDataBuffer()
    assert.ok(body?.length)
    body[3]^=255
    const response=await route.fetch({postData:body})
    await route.fulfill({response})
  })
  const rejection=page.waitForResponse(response=>response.url().includes('/chunks/0/commit')&&response.status()===422)
  row=await add('corrupt-part-retry.bin')
  const rejected=await rejection
  const id=rejected.url().match(/\/uploads\/([^/]+)\//)[1]
  const saved=await(await context.request.get(url+'/api/uploads/'+id)).json()
  assert.equal(saved.committedBytes,0);assert.equal(saved.nextChunk,0)
  await row.locator('.state-retrying').waitFor()
  await shot('22-corrupt-part-whole-chunk-retry')
  await complete(row,'corrupt-part-retry.bin')
  await page.unroute('**/api/uploads/*/attempts/*/parts/1')
  check('corrupting one parallel part yields checksum rejection, zero committed bytes, and a byte-identical whole-chunk retry')

  const workers=await page.evaluate(()=>window.__filebrowserHashCount)
  let held
  const startPattern='**/api/uploads/*/chunks/4/start'
  await page.route(startPattern,route=>{held=route})
  row=await add('pause-resume.bin')
  for(let retry=0;!held&&retry<300;retry++)await page.waitForTimeout(100)
  assert.ok(held)
  await row.getByRole('button',{name:'Pause pause-resume.bin',exact:true}).click()
  await row.getByText('Paused',{exact:true}).waitFor()
  await page.unroute(startPattern)
  await held.abort().catch(()=>{})
  await shot('23-paused-transfer')
  await row.getByRole('button',{name:'Resume',exact:true}).click()
  await complete(row,'pause-resume.bin')
  assert.equal(await page.evaluate(()=>window.__filebrowserHashCount),workers+1)
  check('same-tab pause/resume retains its verified manifest and hashes the file only once')

  held=undefined
  await page.route(startPattern,route=>{held=route})
  row=await add('cancel-transfer.bin')
  for(let retry=0;!held&&retry<300;retry++)await page.waitForTimeout(100)
  assert.ok(held)
  const session=(await(await context.request.get(url+'/api/uploads')).json()).find(value=>value.name==='cancel-transfer.bin')
  assert.equal(session.committedBytes,409600)
  assert.equal((await(await context.request.get(url+'/api/files')).json()).entries.find(e=>e.name==='cancel-transfer.bin.uploading').uploading,true)
  await row.getByRole('button',{name:'Cancel cancel-transfer.bin',exact:true}).click()
  await page.getByRole('button',{name:'Cancel transfer',exact:true}).click()
  await row.waitFor({state:'detached'})
  await page.unroute(startPattern);await held.abort().catch(()=>{})
  const canceled=await(await context.request.get(url+'/api/uploads/'+session.id)).json()
  assert.equal(canceled.status,'canceled')
  await assert.rejects(access(join('/verify-files','.filebrowser-uploads',session.id)),{code:'ENOENT'})
  await assert.rejects(access('/verify-files/cancel-transfer.bin.uploading'),{code:'ENOENT'})
  assert.equal((await context.request.get(url+'/api/files/content?path=/cancel-transfer.bin')).status(),404)
  await shot('24-canceled-transfer')
  check('browser cancellation after four committed chunks removes staging and never publishes a partial file')
  assert.deepEqual(errors,[]);check('no unhandled browser errors during fault recovery')
  for(const name of ['lost-ack.bin','corrupt-part-retry.bin','pause-resume.bin'])assert.equal((await context.request.delete(url+'/api/files?path='+encodeURIComponent('/'+name),{headers:{'X-Filebrowser-Request':'1'}})).status(),200)
  await writeFile(join(output,'browser-fault-results.json'),JSON.stringify({status:'PASS',results,expectedHash:expected,size:bytes.length,errors},null,2))
} catch(error) {
  await shot('failure-browser-faults').catch(()=>{})
  await writeFile(join(output,'browser-fault-results.json'),JSON.stringify({status:'FAIL',error:error.stack,results,errors},null,2));throw error
} finally {await browser.close()}
