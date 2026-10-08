import { FULL_PERMISSIONS, type Target, type TargetAccess, type User } from '@/shared/types'
export const targetFiles = (targetId: string) => `/targets/${encodeURIComponent(targetId)}/files`
export function targetAccess(user: User, target: Target | null): TargetAccess | null {
  if (!target || !target.enabled) return null
  const grant = user.role === 'admin' ? { scope: '/', permissions: FULL_PERMISSIONS } : user.grants.find(grant => grant.targetId === target.id)
  return grant ? { ...user, ...grant, targetId: target.id, storageReadOnly: target.readOnly } : null
}
