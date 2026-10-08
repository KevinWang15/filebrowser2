import { randomBytes } from 'node:crypto'
import { md4 } from 'hash-wasm'

export interface ShareProvider {
  readonly id: string
  readonly name: string
  readonly readOnly: boolean
  credentials(): Promise<{ password: string; secret: string }>
}

export const smbProvider: ShareProvider = {
  id: 'smb', name: 'SMB', readOnly: true,
  async credentials() {
    // SMB requires an NT verifier. Keep browser passwords on scrypt and issue a
    // separate, high-entropy protocol password instead of reusing them.
    const password = randomBytes(24).toString('base64url')
    const secret = (await md4(Buffer.from(password, 'utf16le'))).toUpperCase()
    return { password, secret }
  },
}
