import type { TargetConnection, TargetType } from '@/shared/types'
export const TARGET_LABELS: Record<TargetType, string> = { local: 'Local filesystem', s3: 'S3 compatible storage', ftp: 'FTP / FTPS', sftp: 'SFTP' }
export function emptyConnection(type: TargetType, localPath = './data'): TargetConnection {
  switch (type) {
    case 'local': return { type, root: localPath }
    case 's3': return { type, bucket: '', region: 'us-east-1', endpoint: '', prefix: '', accessKeyId: '', secretAccessKey: '', sessionToken: '', forcePathStyle: false }
    case 'ftp': return { type, host: '', port: 21, root: '/', username: '', password: '', tls: true }
    case 'sftp': return { type, host: '', port: 22, root: '/', username: '', password: '', privateKey: '', passphrase: '', hostKey: '' }
  }
}
