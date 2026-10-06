import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))

test('Prisma works without checked-in models or generated code', { timeout: 90_000 }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'ts-starter-prisma-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  for (const directory of ['prisma', 'backend']) await mkdir(join(fixture, directory))
  for (const file of ['package.json', 'prisma.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'prisma/schema.prisma', 'backend/db.ts']) {
    await copyFile(join(project, file), join(fixture, file))
  }
  await symlink(join(project, 'node_modules'), join(fixture, 'node_modules'), 'junction')

  // Never use the developer's DATABASE_URL for integration tests.
  const env = { ...process.env }
  delete env.DATABASE_URL
  const run = (tool, args, extraEnv = {}) => execute(process.execPath, [
    join(project, 'node_modules', tool), ...args,
  ], { cwd: fixture, env: { ...env, ...extraEnv }, timeout: 30_000 })
  const prisma = (args, extraEnv) => run('prisma/build/index.js', args, extraEnv)

  await t.test('validates and generates an empty schema without database credentials', async () => {
    await prisma(['validate'])
    await prisma(['generate'])
    await run('typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.node.json'])
    await writeFile(join(fixture, 'backend/check.ts'), `
import assert from 'node:assert/strict'
import { createDb } from './db.ts'
assert.throws(() => createDb(), /DATABASE_URL is required/)
const db = createDb('postgresql://unused:unused@127.0.0.1:1/unused')
await db.$disconnect()
`)
    await run('tsx/dist/cli.mjs', ['backend/check.ts'])
  })

  await t.test('generates typed model queries from a temporary schema', async () => {
    const schemaFile = join(fixture, 'prisma/schema.prisma')
    await writeFile(schemaFile, `${await readFile(schemaFile, 'utf8')}\nmodel StarterCheck {
  id Int @id @default(autoincrement())
  value String
}\n`)
    await prisma(['generate'])
    await writeFile(join(fixture, 'backend/query.ts'), `
import assert from 'node:assert/strict'
import { createDb } from './db.ts'
const db = createDb()
try {
  const created = await db.starterCheck.create({ data: { value: 'temporary-fixture' } })
  const found = await db.starterCheck.findUniqueOrThrow({ where: { id: created.id } })
  assert.equal(found.value, 'temporary-fixture')
  await db.starterCheck.delete({ where: { id: created.id } })
} finally {
  await db.$disconnect()
}
`)
    await run('typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.node.json'])
  })

  await t.test('deploys a migration and queries a disposable PostgreSQL database', {
    skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
  }, async () => {
    const { stdout: sql } = await prisma(['migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'])
    const migrations = join(fixture, 'prisma/migrations')
    await mkdir(join(migrations, '20260911000000_fixture'), { recursive: true })
    await writeFile(join(migrations, 'migration_lock.toml'), 'provider = "postgresql"\n')
    await writeFile(join(migrations, '20260911000000_fixture/migration.sql'), sql)
    const databaseEnv = { DATABASE_URL: process.env.TEST_DATABASE_URL }
    await prisma(['migrate', 'deploy'], databaseEnv)
    await run('tsx/dist/cli.mjs', ['backend/query.ts'], databaseEnv)
  })
})
