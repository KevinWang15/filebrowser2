import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Store } from '../backend/store.ts'
import { Operations } from '../backend/operations/manager.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'filebrowser-operations-')), store = new Store(root)
  for (const id of ['first', 'second', 'third']) store.db.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,'admin',?)").run(id, id, 'unused-test-hash', new Date().toISOString())
  const users = Object.fromEntries(store.users().map(row => [row.id, store.publicUser(row)])), handlers = {}, errors = []
  const create = () => new Operations(store, root, handlers, () => false, (_key, run) => run(), error => errors.push(error))
  let manager = create()
  await manager.init()
  t.after(async () => { await manager.close(); store.close(); await rm(root, { recursive: true, force: true }); assert.deepEqual(errors, []) })
  const wait = async (id, owner = users.first) => {
    for (let i = 0; i < 500; i++) { const operation = manager.list(owner).find(operation => operation.id === id); if (operation?.status !== 'running') return operation; await delay(10) }
    assert.fail('Operation did not finish')
  }
  const plan = execute => ({ title: 'Count records', description: 'Test records', unit: 'record', timeoutMs: 10000, check() {}, async validate() {}, execute })
  return { root, store, get manager() { return manager }, users, handlers, wait, plan, async restart() { await manager.close(); manager = create(); await manager.init() } }
}

test('non-archive handlers share progress, persistence, ownership and explicit dismissal', async t => {
  const f = await fixture(t)
  f.handlers['test.count'] = () => f.plan(async context => {
    context.report({ phase: 'Counting', totalItems: 2, processedItems: 1, progress: 0.5, currentItem: 'first' }, true)
    await writeFile(join(context.directory, 'private-scratch'), 'temporary')
    await delay(30)
    context.report({ processedItems: 2, progress: 1 })
  })
  const operation = await f.manager.start(f.users.first, 'test.count', {})
  const finished = await f.wait(operation.id)
  assert.equal(finished.status, 'completed'); assert.equal(finished.progress, 1); assert.equal(finished.processedItems, 2); assert.equal(finished.targetId, null)
  assert.deepEqual(f.manager.list(f.users.second), [])
  assert.throws(() => f.manager.clear(f.users.second, operation.id), { statusCode: 404 })
  await assert.rejects(f.manager.cancel(f.users.second, operation.id), { statusCode: 404 })
  assert.deepEqual(await readdir(join(f.root, 'operations-work')), [])
  await f.restart()
  assert.equal(f.manager.list(f.users.first)[0].status, 'completed')
  assert.deepEqual(f.manager.clear(f.users.first, operation.id), { clearedIds: [operation.id] })
  await f.restart()
  assert.deepEqual(f.manager.list(f.users.first), [])
  await assert.rejects(f.manager.start(f.users.first, 'unknown', {}), { statusCode: 400 })
  await assert.rejects(f.manager.start(f.users.first, 'toString', {}), { statusCode: 400 })
})

test('cancellation, global concurrency and clear-finished are shared across operation types', async t => {
  const f = await fixture(t)
  const execute = async context => { context.report({ phase: 'Waiting' }); await delay(60000, undefined, { signal: context.signal }) }
  f.handlers['test.first'] = () => f.plan(execute)
  f.handlers['test.second'] = () => f.plan(execute)
  const first = await f.manager.start(f.users.first, 'test.first', {})
  const second = await f.manager.start(f.users.second, 'test.second', {})
  await assert.rejects(f.manager.start(f.users.first, 'test.second', {}), { statusCode: 429 })
  await assert.rejects(f.manager.start(f.users.third, 'test.second', {}), { statusCode: 429 })
  assert.throws(() => f.manager.clear(f.users.first, first.id), { statusCode: 409 })
  assert.deepEqual(f.manager.clear(f.users.first), { clearedIds: [] })
  assert.equal((await f.manager.cancel(f.users.first, first.id)).status, 'canceled')
  assert.deepEqual(f.manager.clear(f.users.first), { clearedIds: [first.id] })
  assert.equal(f.manager.list(f.users.second)[0].id, second.id)
  await f.manager.cancel(f.users.second, second.id)
  const next = await f.manager.start(f.users.third, 'test.first', {})
  assert.equal((await f.manager.cancel(f.users.third, next.id)).status, 'canceled')
})

test('timeouts, failed handlers, shutdown and restart release scratch space and retain visible failures', async t => {
  const f = await fixture(t)
  f.handlers['test.timeout'] = () => ({ ...f.plan(async context => { await delay(60000, undefined, { signal: context.signal }) }), timeoutMs: 30 })
  f.handlers['test.failure'] = () => f.plan(async () => { throw new Error('Expected fixture failure') })
  const timeout = await f.manager.start(f.users.first, 'test.timeout', {})
  assert.match((await f.wait(timeout.id)).error, /time limit/)
  const failure = await f.manager.start(f.users.first, 'test.failure', {})
  assert.equal((await f.wait(failure.id)).error, 'Expected fixture failure')
  const data = JSON.parse(f.store.db.prepare('SELECT data FROM operations WHERE id=?').get(failure.id).data)
  data.status = 'running'; f.store.db.prepare('UPDATE operations SET data=? WHERE id=?').run(JSON.stringify(data), failure.id)
  await f.restart()
  assert.match(f.manager.list(f.users.first).find(operation => operation.id === failure.id).error, /restarted/)
  const active = await f.manager.start(f.users.first, 'test.timeout', {})
  await f.manager.close()
  assert.match(f.manager.list(f.users.first).find(operation => operation.id === active.id).error, /Server stopped/)
  await assert.rejects(f.manager.start(f.users.first, 'test.failure', {}), { statusCode: 503 })
  assert.deepEqual(await readdir(join(f.root, 'operations-work')), [])
})

test('rejected validation releases its slot and account revocation interrupts any use case', async t => {
  const f = await fixture(t)
  f.handlers['test.invalid'] = () => ({ ...f.plan(async () => assert.fail('Invalid work must not execute')), async validate() { throw new Error('Invalid input') } })
  await assert.rejects(f.manager.start(f.users.first, 'test.invalid', {}), /Invalid input/)
  assert.deepEqual(f.manager.list(f.users.first), [])
  f.handlers['test.wait'] = () => f.plan(async context => { await delay(60000, undefined, { signal: context.signal }) })
  const operation = await f.manager.start(f.users.first, 'test.wait', {})
  f.store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.users.first.id)
  assert.match((await f.wait(operation.id)).error, /revoked/)
  assert.deepEqual(await readdir(join(f.root, 'operations-work')), [])
})

test('validation observes the operation deadline', async t => {
  const f = await fixture(t)
  f.handlers['test.slow-validation'] = () => ({ ...f.plan(async () => assert.fail('Expired validation must not execute')),
    timeoutMs: 30, async validate(context) {
      await delay(1000, undefined, { signal: context.signal })
    } })
  await assert.rejects(f.manager.start(f.users.first, 'test.slow-validation', {}), /time limit/)
  assert.deepEqual(f.manager.list(f.users.first), [])
  assert.deepEqual(await readdir(join(f.root, 'operations-work')), [])
})

test('rejected validation removes its private scratch and releases the operation slot', async t => {
  const f = await fixture(t)
  f.handlers['test.invalid-scratch'] = () => ({ ...f.plan(async () => assert.fail('Invalid work must not execute')),
    async validate(context) {
      await mkdir(context.directory, { recursive: true, mode: 0o700 })
      await writeFile(join(context.directory, 'validation-scratch'), 'temporary')
      throw new Error('Invalid input')
    } })
  await assert.rejects(f.manager.start(f.users.first, 'test.invalid-scratch', {}), /Invalid input/)
  assert.deepEqual(f.manager.list(f.users.first), [])
  assert.deepEqual(await readdir(join(f.root, 'operations-work')), [])
  f.handlers['test.next'] = () => f.plan(async () => {})
  assert.equal((await f.wait((await f.manager.start(f.users.first, 'test.next', {})).id)).status, 'completed')
})

test('access revocation and shutdown interrupt validation before work can execute', async t => {
  const f = await fixture(t)
  let ready
  f.handlers['test.validation'] = () => ({ ...f.plan(async () => assert.fail('Interrupted validation must not execute')),
    async validate(context) { ready(); await delay(60000, undefined, { signal: context.signal }) } })
  const validating = new Promise(resolve => { ready = resolve })
  const revoked = assert.rejects(f.manager.start(f.users.first, 'test.validation', {}), /revoked/)
  await validating
  f.store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.users.first.id)
  await revoked
  const nextValidating = new Promise(resolve => { ready = resolve })
  const stopped = assert.rejects(f.manager.start(f.users.second, 'test.validation', {}), /Server stopped/)
  await nextValidating
  await f.manager.close(); await stopped
  assert.deepEqual(f.manager.list(f.users.second), [])
  assert.deepEqual(await readdir(join(f.root, 'operations-work')), [])
})
