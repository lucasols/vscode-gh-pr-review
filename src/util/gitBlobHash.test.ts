import { expect, test } from 'vitest'
import { gitBlobSha } from './gitBlobHash'

test('matches the hash of git hash-object', () => {
  // `printf 'hello\n' | git hash-object --stdin`
  expect(gitBlobSha(new TextEncoder().encode('hello\n'))).toBe(
    'ce013625030ba8dba906f756967f9e9ca394464a',
  )
  // the empty blob
  expect(gitBlobSha(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
})
