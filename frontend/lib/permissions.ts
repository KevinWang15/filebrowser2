import { IconDownload, IconEye, IconFolderPlus, IconPencil, IconTrash, IconUpload, type Icon } from '@tabler/icons-react'
import type { Permission, Permissions, User } from '@/shared/types'

export const PERMISSION_META: Record<Permission, { label: string; description: string; icon: Icon }> = {
  read: { label: 'Browse & preview', description: 'See files and text previews', icon: IconEye },
  download: { label: 'Download', description: 'Save files to their device', icon: IconDownload },
  upload: { label: 'Upload', description: 'Add files to their folder', icon: IconUpload },
  create: { label: 'Create folders', description: 'Organize with new folders', icon: IconFolderPlus },
  rename: { label: 'Rename', description: 'Change file and folder names', icon: IconPencil },
  delete: { label: 'Delete', description: 'Remove files and empty folders', icon: IconTrash },
}

export const can = (user: User, permission: keyof Permissions) => user.role === 'admin' || user.permissions[permission]
