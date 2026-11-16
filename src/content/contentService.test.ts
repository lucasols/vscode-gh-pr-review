import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ContentService, type ContentSource, type LocalGit } from './contentService'
import type { DocRef } from './docRef'

const text = (value: string) => new TextEncoder().encode(value)

let cacheDir: string
const noLocalGit: LocalGit = {
  findRoot: () => undefined,
  run: () => Promise.reject(new Error('no local git')),
}

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'gh-pr-review-test-'))
})

afterEach(async () => {
  // the disk cache is written in the background and can still be in progress
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

function createSource() {
  return {
    readBlob: vi.fn<ContentSource['readBlob']>((_repo, sha) =>
      Promise.resolve(text(`blob ${sha}`)),
    ),
    readFileAtCommit: vi.fn<ContentSource['readFileAtCommit']>((_repo, commit, path) =>
      Promise.resolve(path === 'missing.ts' ? undefined : text(`${commit}:${path}`)),
    ),
  }
}

const blobRef: DocRef = { repo: 'acme/app', pr: 1, path: 'a.ts', side: 'head', blob: 'abc' }
const commitRef: DocRef = {
  repo: 'acme/app',
  pr: 1,
  path: 'a.ts',
  side: 'base',
  commit: 'c1',
  srcPath: 'old.ts',
}

test('reads a blob from GitHub once and then from the cache', async () => {
  const source = createSource()
  const service = new ContentService(source, noLocalGit, cacheDir)

  const [a, b] = await Promise.all([service.readText(blobRef), service.readText(blobRef)])
  expect(a).toBe('blob abc')
  expect(b).toBe('blob abc')
  await service.readText(blobRef)

  expect(source.readBlob).toHaveBeenCalledTimes(1)
  expect(source.readBlob).toHaveBeenCalledWith({ owner: 'acme', name: 'app' }, 'abc')
})

test('a new instance reads from the disk cache', async () => {
  const source = createSource()
  await new ContentService(source, noLocalGit, cacheDir).read(blobRef)
  // the disk write is not awaited by read
  await vi.waitFor(async () => {
    const second = createSource()
    const content = await new ContentService(second, noLocalGit, cacheDir).readText(blobRef)
    expect(content).toBe('blob abc')
    expect(second.readBlob).not.toHaveBeenCalled()
  })
})

test('reads a file at a commit by its source path', async () => {
  const source = createSource()
  const service = new ContentService(source, noLocalGit, cacheDir)
  expect(await service.readText(commitRef)).toBe('c1:old.ts')
})

test('a file that does not exist at the commit is empty', async () => {
  const service = new ContentService(createSource(), noLocalGit, cacheDir)
  const content = await service.read({ ...commitRef, srcPath: 'missing.ts' })
  expect(content.byteLength).toBe(0)
})

test('the empty side needs no request', async () => {
  const source = createSource()
  const service = new ContentService(source, noLocalGit, cacheDir)
  const content = await service.read({ repo: 'acme/app', pr: 1, path: 'a.ts', side: 'empty' })
  expect(content.byteLength).toBe(0)
  expect(source.readBlob).not.toHaveBeenCalled()
})

test('prefers the local clone when it has the object', async () => {
  const source = createSource()
  const run = vi.fn<LocalGit['run']>((_cwd, args) =>
    Promise.resolve(Buffer.from(`local ${args.join(' ')}`)),
  )
  const service = new ContentService(source, { findRoot: () => '/work/app', run }, cacheDir)

  expect(await service.readText(blobRef)).toBe('local cat-file blob abc')
  expect(await service.readText(commitRef)).toBe('local cat-file blob c1:old.ts')
  expect(source.readBlob).not.toHaveBeenCalled()
  expect(source.readFileAtCommit).not.toHaveBeenCalled()
})

test('falls back to GitHub when the local clone does not have the commit', async () => {
  const source = createSource()
  const run = vi.fn<LocalGit['run']>(() => Promise.reject(new Error('bad object')))
  const service = new ContentService(source, { findRoot: () => '/work/app', run }, cacheDir)

  expect(await service.readText(commitRef)).toBe('c1:old.ts')
  expect(await service.readText(blobRef)).toBe('blob abc')
})

test('a path that is missing in a commit that exists locally is empty, without asking GitHub', async () => {
  const source = createSource()
  const run = vi.fn<LocalGit['run']>((_cwd, args) =>
    args[1] === '-e' ? Promise.resolve(Buffer.from('')) : Promise.reject(new Error('no path')),
  )
  const service = new ContentService(source, { findRoot: () => '/work/app', run }, cacheDir)

  expect((await service.read(commitRef)).byteLength).toBe(0)
  expect(source.readFileAtCommit).not.toHaveBeenCalled()
})
