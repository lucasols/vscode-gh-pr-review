import { createHash } from 'node:crypto'

/** The SHA-1 that git gives to a blob with this content */
export function gitBlobSha(content: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex')
}
