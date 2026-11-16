import { expect, test } from 'vitest'
import { isLockfile } from './lockfiles'

test('recognizes lockfiles in any folder', () => {
  expect(isLockfile('pnpm-lock.yaml')).toBe(true)
  expect(isLockfile('.mastra/output/pnpm-lock.yaml')).toBe(true)
  expect(isLockfile('apps/web/package-lock.json')).toBe(true)
  expect(isLockfile('yarn.lock')).toBe(true)
  expect(isLockfile('Cargo.lock')).toBe(true)
  expect(isLockfile('go.sum')).toBe(true)
})

test('does not match files that only look similar', () => {
  expect(isLockfile('package.json')).toBe(false)
  expect(isLockfile('src/lock.ts')).toBe(false)
  expect(isLockfile('docs/pnpm-lock.yaml.md')).toBe(false)
  expect(isLockfile('my-pnpm-lock.yaml')).toBe(false)
})
