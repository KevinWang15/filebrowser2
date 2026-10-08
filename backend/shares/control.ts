import { z } from 'zod'

export const SHARE_LEASE_MS = 10_000
const identitySchema = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict()
export const shareNameSchema = z.string().min(1).max(48).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, numbers, underscores or hyphens')
  .refine(name => !['global', 'homes', 'printers', 'ipc$'].includes(name.toLowerCase()), 'This share name is reserved')
export const controlShareSchema = z.object({
  id: z.string().uuid(), name: shareNameSchema,
  path: z.string().max(4096).refine(path => path.startsWith('/') && !/[\\%]/.test(path) && ![...path].some(character => character.charCodeAt(0) < 32) && !/\s$/.test(path)
    && path.split('/').every(part => part !== '.' && part !== '..' && !part.startsWith('.filebrowser-')), 'Unsupported SMB directory path'),
  directory: identitySchema, storage: identitySchema.extend({ path: z.string().min(1).max(4096).refine(path => path.startsWith('/') && !/[\\%\r\n]/.test(path) && !/\s$/.test(path), 'Invalid export root') }),
  username: z.string().regex(/^fb_[a-f0-9]{24}$/), uid: z.number().int().min(100_001).max(2_000_000_000),
  ntHash: z.string().regex(/^[A-F0-9]{32}$/),
}).strict()
export const controlSchema = z.object({
  version: z.literal(2), protocol: z.literal('smb'), revision: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().nonnegative(),
  access: z.object({ uid: z.number().int().nonnegative().max(2_147_483_647), gid: z.number().int().nonnegative().max(2_147_483_647), groups: z.array(z.number().int().nonnegative().max(2_147_483_647)).max(256) }).strict(),
  shares: z.array(controlShareSchema).max(200),
}).strict().superRefine((value, context) => {
  for (const field of ['id', 'name'] as const) {
    const values = value.shares.map(share => typeof share[field] === 'string' ? String(share[field]).toLowerCase() : share[field])
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: `Duplicate share ${field}` })
  }
  const accounts = new Map<string, { uid: number; ntHash: string }>(), identities = new Map<number, string>()
  for (const share of value.shares) {
    const previous = accounts.get(share.username)
    if ((previous && (previous.uid !== share.uid || previous.ntHash !== share.ntHash)) || (identities.has(share.uid) && identities.get(share.uid) !== share.username)) {
      context.addIssue({ code: 'custom', message: 'Conflicting SMB account identity' })
    }
    accounts.set(share.username, { uid: share.uid, ntHash: share.ntHash }); identities.set(share.uid, share.username)
  }
})
export type ShareControl = z.infer<typeof controlSchema>
export type ControlShare = z.infer<typeof controlShareSchema>

export const agentStatusSchema = z.object({
  version: z.literal(2), revision: z.string(), checkedAt: z.number(), ready: z.boolean(),
  error: z.string().max(200), active: z.array(z.string().uuid()).max(200), failed: z.array(z.string().uuid()).max(200),
}).strict()
export type ShareAgentStatus = z.infer<typeof agentStatusSchema>
