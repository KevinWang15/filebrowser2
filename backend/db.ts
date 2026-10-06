import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client.ts'

// Create once per application process, then reuse its connection pool.
// Call db.$disconnect() during graceful shutdown.
export function createDb(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to create the Prisma client')
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  })
}
