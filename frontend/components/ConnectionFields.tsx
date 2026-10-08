import type { TargetConnection } from '@/shared/types'

const LABELS: Record<string, string> = { root: 'Root directory', bucket: 'Bucket', region: 'Region', endpoint: 'S3 endpoint', prefix: 'Key prefix',
  accessKeyId: 'Access key ID', secretAccessKey: 'Secret access key', sessionToken: 'Session token', host: 'Host', port: 'Port', username: 'Remote username',
  password: 'Remote password', privateKey: 'SSH private key', passphrase: 'Key passphrase', hostKey: 'Server host key fingerprint', forcePathStyle: 'Use path-style requests', tls: 'Use TLS (FTPS)' }
const SECRETS = ['accessKeyId', 'secretAccessKey', 'sessionToken', 'password', 'privateKey', 'passphrase']

export function ConnectionFields({ value, onChange, secrets = [], fixedLocation = false }: {
  value: TargetConnection; onChange: (value: TargetConnection) => void; secrets?: string[]; fixedLocation?: boolean
}) {
  const update = (field: string, next: string | number | boolean) => onChange({ ...value, [field]: next } as TargetConnection)
  const location = value.type === 'local' ? ['root'] : value.type === 's3' ? ['bucket', 'endpoint', 'prefix'] : ['host', 'port', 'root']
  return <div className="target-fields">{Object.entries(value).filter(([field]) => field !== 'type').map(([field, current]) => {
    const id = 'connection-' + field, secret = SECRETS.includes(field), optional = ['endpoint', 'prefix', ...SECRETS].includes(field)
    return typeof current === 'boolean' ? <label className="perm-option" key={field}><span className="perm-text"><strong>{LABELS[field]}</strong></span><input className="switch" type="checkbox" checked={current} onChange={event => update(field, event.target.checked)} /></label> :
      <div className="field" key={field}><label htmlFor={id}>{LABELS[field]}</label>
        {field === 'privateKey' ? <textarea id={id} className="input mono" rows={3} value={current} autoComplete="off" placeholder={secrets.includes(field) ? 'Leave blank to keep saved key' : 'Optional: paste an OpenSSH private key'} onChange={event => update(field, event.target.value)} /> :
          <input id={id} className="input" type={typeof current === 'number' ? 'number' : secret ? 'password' : 'text'} value={current} required={!optional} autoComplete="off" spellCheck={false}
            min={typeof current === 'number' ? 1 : undefined} max={typeof current === 'number' ? 65535 : undefined} disabled={fixedLocation && location.includes(field)}
            placeholder={secrets.includes(field) ? 'Leave blank to keep saved secret' : field === 'hostKey' ? 'SHA256:… (from the server administrator)' : field === 'endpoint' ? 'Optional: default AWS endpoint' : ''}
            onChange={event => update(field, typeof current === 'number' ? Number(event.target.value) : event.target.value)} />}
        {field === 'root' && <span className="field-hint">Paths shown in the browser are relative to this directory.</span>}
      </div>
  })}{value.type === 'ftp' && <p className="field-hint">Uploads require REST STREAM and verify saved bytes. FTP has no durable flush or exclusive rename; use SFTP or S3 for stronger crash guarantees.</p>}
  {value.type === 'sftp' && <p className="field-hint">The server must support the OpenSSH fsync extension for durable uploads. Verify the host key with your server administrator.</p>}
  </div>
}
