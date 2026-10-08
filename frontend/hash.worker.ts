import { createSHA256 } from 'hash-wasm'

self.onmessage = async (event: MessageEvent<{ file: File; chunkSize: number }>) => {
  const file = event.data.file
  const chunkSize = event.data.chunkSize
  try {
    const hasher = await createSHA256()
    const hashes: string[] = []
    let reportedAt = 0
    for (let chunkStart = 0; chunkStart < file.size; chunkStart += chunkSize) {
      hasher.init()
      const chunkEnd = Math.min(chunkStart + chunkSize, file.size)
      // The whole file is scanned, but only a 4 MiB read buffer is ever allocated.
      for (let offset = chunkStart; offset < chunkEnd; offset += 4 * 1024 * 1024) {
        const end = Math.min(offset + 4 * 1024 * 1024, chunkEnd)
        hasher.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()))
        if (Date.now() - reportedAt > 100 || end === file.size) {
          self.postMessage({ type: 'progress', bytes: end })
          reportedAt = Date.now()
        }
      }
      hashes.push(hasher.digest('hex'))
    }
    hasher.init()
    hasher.update(JSON.stringify({ version: 1, size: file.size, chunkSize, hashes }))
    self.postMessage({ type: 'done', hashes, manifestHash: hasher.digest('hex') })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not read this file' })
  }
}
