import { cp } from 'node:fs/promises'

// Vite bundles the frontend dependencies and font assets. Keep their full
// notices beside the built assets so standalone frontend distributions comply.
await cp('licenses', 'dist/client/licenses', { recursive: true })
await cp('THIRD_PARTY_NOTICES.md', 'dist/client/licenses/THIRD_PARTY_NOTICES.md')
