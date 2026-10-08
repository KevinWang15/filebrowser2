import { useState } from 'react'
import { IconPhotoOff } from '@tabler/icons-react'
import type { FileEntry, TargetAccess } from '@/shared/types'
import { FileIcon } from '../../components/FileIcon'
import { Spinner } from '../../components/ui'
import { contentUrl, previewKind } from '../../lib/format'
import { useTextPreview } from '../../lib/files'
import { can } from '../../lib/permissions'

const MAX_LINES = 4000

/** Text or image preview for a file. `className` lets the inspector and the viewer style it independently. */
export function Preview({ entry, user, className, delay = 0, limit }: { entry: FileEntry; user: TargetAccess; className: string; delay?: number; limit?: number }) {
  const kind = previewKind(entry)
  const allowed = kind === 'text' ? can(user, 'read') : kind === 'image' ? can(user, 'download') : false
  const text = useTextPreview(user.targetId, kind === 'text' && allowed ? entry.path : null, delay)
  const [broken, setBroken] = useState<string | null>(null)
  if (!kind || !allowed) return null
  if (kind === 'image') {
    if (broken === entry.path) return <div className={`preview-empty ${className}-empty`}><IconPhotoOff size={22} stroke={1.5} /><span>This image could not be displayed</span></div>
    return <div className={`preview-image ${className}`}><img src={contentUrl(user.targetId, entry.path)} alt={entry.name} decoding="async" onError={() => setBroken(entry.path)} /></div>
  }
  if (text.error) return <div className={`preview-empty ${className}-empty`}><FileIcon entry={entry} size={22} /><span>{text.error}</span></div>
  if (text.value === undefined) return <div className={`preview-empty ${className}-empty`}><Spinner /><span>Loading preview…</span></div>
  const lines = text.value.split('\n')
  const shown = limit ? lines.slice(0, limit) : lines.slice(0, MAX_LINES)
  const hidden = lines.length - shown.length
  return <pre className={className} tabIndex={0} aria-label={`Preview of ${entry.name}`}>
    <code>{shown.join('\n')}</code>
    {hidden > 0 && !limit && <span className="preview-more">… {hidden.toLocaleString()} more lines. Download the file to see everything.</span>}
  </pre>
}
