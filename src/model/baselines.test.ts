import { describe, expect, test } from 'vitest'
import {
  BASELINE_SETTLE_MS,
  BaselineStore,
  isChangedSinceViewed,
  markViewedBaselines,
  reconcileBaselines,
  removeBaselines,
  type BaselineMap,
  type BaselineStorage,
} from './baselines'
import type { FileStatus, ViewedState } from './types'

function file(
  path: string,
  viewedState: ViewedState,
  blobSha: string | undefined,
  status: FileStatus = 'modified',
) {
  return { path, viewedState, blobSha, status }
}

const T0 = 1_000_000
const SETTLED = T0 + BASELINE_SETTLE_MS

describe('reconcileBaselines', () => {
  test('records a baseline for files that GitHub reports as viewed', () => {
    const result = reconcileBaselines({
      current: {},
      files: [file('a.ts', 'VIEWED', 'blob-a'), file('b.ts', 'UNVIEWED', 'blob-b')],
      headSha: 'head-1',
      headFirstSeenAt: T0,
      now: T0,
    })

    expect(result.changed).toBe(true)
    expect(result.next).toEqual({ 'a.ts': { blob: 'blob-a', commit: 'head-1', at: T0 } })
  })

  test('keeps the baseline when the file changes and GitHub dismisses the viewed state', () => {
    const current: BaselineMap = { 'a.ts': { blob: 'blob-a', commit: 'head-1', at: T0 } }
    const result = reconcileBaselines({
      current,
      files: [file('a.ts', 'DISMISSED', 'blob-a2')],
      headSha: 'head-2',
      headFirstSeenAt: SETTLED,
      now: SETTLED + BASELINE_SETTLE_MS,
    })

    expect(result.changed).toBe(false)
    expect(result.next).toEqual(current)
  })

  test('does not replace a baseline right after a push, when GitHub may still report the old viewed state', () => {
    const current: BaselineMap = { 'a.ts': { blob: 'blob-a', commit: 'head-1', at: T0 } }
    const result = reconcileBaselines({
      current,
      files: [file('a.ts', 'VIEWED', 'blob-a2')],
      headSha: 'head-2',
      headFirstSeenAt: SETTLED,
      now: SETTLED + 1000,
    })

    expect(result.changed).toBe(false)
    expect(result.next).toEqual(current)
  })

  test('replaces a baseline when the file is still viewed after the head settled (viewed again elsewhere)', () => {
    const current: BaselineMap = { 'a.ts': { blob: 'blob-a', commit: 'head-1', at: T0 } }
    const now = SETTLED + BASELINE_SETTLE_MS
    const result = reconcileBaselines({
      current,
      files: [file('a.ts', 'VIEWED', 'blob-a2')],
      headSha: 'head-2',
      headFirstSeenAt: SETTLED,
      now,
    })

    expect(result.changed).toBe(true)
    expect(result.next).toEqual({ 'a.ts': { blob: 'blob-a2', commit: 'head-2', at: now } })
  })

  test('does nothing when the viewed file did not change', () => {
    const current: BaselineMap = { 'a.ts': { blob: 'blob-a', commit: 'head-1', at: T0 } }
    const result = reconcileBaselines({
      current,
      files: [file('a.ts', 'VIEWED', 'blob-a')],
      headSha: 'head-2',
      headFirstSeenAt: T0,
      now: SETTLED * 2,
    })

    expect(result.changed).toBe(false)
    expect(result.next).toEqual(current)
  })

  test('drops the baselines of files that left the pull request', () => {
    const result = reconcileBaselines({
      current: {
        'a.ts': { blob: 'blob-a', commit: 'head-1', at: T0 },
        'gone.ts': { blob: 'blob-g', commit: 'head-1', at: T0 },
      },
      files: [file('a.ts', 'VIEWED', 'blob-a')],
      headSha: 'head-2',
      headFirstSeenAt: T0,
      now: SETTLED,
    })

    expect(result.changed).toBe(true)
    expect(Object.keys(result.next)).toEqual(['a.ts'])
  })

  test('a viewed removed file gets a marker as baseline', () => {
    const result = reconcileBaselines({
      current: {},
      files: [file('old.ts', 'VIEWED', undefined, 'removed')],
      headSha: 'head-1',
      headFirstSeenAt: T0,
      now: T0,
    })
    expect(result.next['old.ts']?.blob).toBe('removed')
  })

  test('a viewed file without a known blob gets no baseline', () => {
    const result = reconcileBaselines({
      current: {},
      files: [file('a.ts', 'VIEWED', undefined)],
      headSha: 'head-1',
      headFirstSeenAt: T0,
      now: T0,
    })
    expect(result.next).toEqual({})
    expect(result.changed).toBe(false)
  })
})

describe('isChangedSinceViewed', () => {
  const baseline = { blob: 'blob-a', commit: 'head-1', at: T0 }

  test('is true when a file that is not viewed anymore has other content than the baseline', () => {
    expect(isChangedSinceViewed(file('a.ts', 'DISMISSED', 'blob-a2'), baseline)).toBe(true)
    expect(isChangedSinceViewed(file('a.ts', 'UNVIEWED', 'blob-a2'), baseline)).toBe(true)
  })

  test('is false while the file is viewed', () => {
    expect(isChangedSinceViewed(file('a.ts', 'VIEWED', 'blob-a2'), baseline)).toBe(false)
  })

  test('is false without a baseline', () => {
    expect(isChangedSinceViewed(file('a.ts', 'DISMISSED', 'blob-a2'), undefined)).toBe(false)
  })

  test('is false when the content is the same as the baseline (only the base changed)', () => {
    expect(isChangedSinceViewed(file('a.ts', 'DISMISSED', 'blob-a'), baseline)).toBe(false)
  })

  test('is true when the file was removed after it was viewed', () => {
    expect(
      isChangedSinceViewed(file('a.ts', 'DISMISSED', undefined, 'removed'), baseline),
    ).toBe(true)
  })

  test('is false when the content is unknown', () => {
    expect(isChangedSinceViewed(file('a.ts', 'DISMISSED', undefined), baseline)).toBe(false)
  })
})

test('markViewedBaselines and removeBaselines', () => {
  const marked = markViewedBaselines(
    { 'keep.ts': { blob: 'k', commit: 'head-0', at: 1 } },
    [
      { path: 'a.ts', blob: 'blob-a' },
      { path: 'unknown.ts', blob: undefined },
    ],
    'head-1',
    T0,
  )
  expect(marked).toEqual({
    'keep.ts': { blob: 'k', commit: 'head-0', at: 1 },
    'a.ts': { blob: 'blob-a', commit: 'head-1', at: T0 },
  })
  expect(removeBaselines(marked, ['a.ts', 'missing.ts'])).toEqual({
    'keep.ts': { blob: 'k', commit: 'head-0', at: 1 },
  })
})

describe('BaselineStore', () => {
  function createStorage(): BaselineStorage & { data: Map<string, unknown> } {
    const data = new Map<string, unknown>()
    return {
      data,
      keys: () => [...data.keys()],
      get: (key) => data.get(key),
      update: (key, value) => {
        if (value === undefined) data.delete(key)
        else data.set(key, value)
        return Promise.resolve()
      },
    }
  }

  test('persists and reloads the baselines of a pull request', () => {
    const storage = createStorage()
    const files: BaselineMap = { 'a.ts': { blob: 'blob-a', commit: 'head-1', at: T0 } }
    new BaselineStore(storage).set('o/r#1', files, T0)

    expect(new BaselineStore(storage).get('o/r#1')).toEqual(files)
    expect(new BaselineStore(storage).get('o/r#2')).toEqual({})
  })

  test('sees the baselines that another window stored', () => {
    const storage = createStorage()
    const thisWindow = new BaselineStore(storage)
    const otherWindow = new BaselineStore(storage)
    const first: BaselineMap = { 'a.ts': { blob: 'blob-1', commit: 'head-1', at: T0 } }
    const second: BaselineMap = { 'a.ts': { blob: 'blob-2', commit: 'head-2', at: T0 + 1 } }

    thisWindow.set('o/r#1', first, T0)
    expect(thisWindow.get('o/r#1')).toBe(first)
    // the parsed value is reused while nothing changed
    expect(otherWindow.get('o/r#1')).toBe(otherWindow.get('o/r#1'))

    otherWindow.set('o/r#1', second, T0 + 1)
    expect(thisWindow.get('o/r#1')).toEqual(second)

    otherWindow.set('o/r#1', {}, T0 + 2)
    expect(thisWindow.get('o/r#1')).toEqual({})
  })

  test('removes the stored entry when there are no baselines left', () => {
    const storage = createStorage()
    const store = new BaselineStore(storage)
    store.set('o/r#1', { 'a.ts': { blob: 'b', commit: 'c', at: 1 } }, T0)
    store.set('o/r#1', {}, T0)
    expect(storage.data.size).toBe(0)
  })

  test('ignores stored data with an unexpected shape', () => {
    const storage = createStorage()
    storage.data.set('baselines:v1:o/r#1', { files: 'nope' })
    expect(new BaselineStore(storage).get('o/r#1')).toEqual({})
  })

  test('prune keeps the most recently updated pull requests', () => {
    const storage = createStorage()
    const store = new BaselineStore(storage)
    for (let i = 0; i < 305; i++) {
      store.set(`o/r#${i}`, { 'a.ts': { blob: 'b', commit: 'c', at: 1 } }, i)
    }
    storage.data.set('other-key', 1)

    store.prune()

    expect(storage.data.has('other-key')).toBe(true)
    expect(storage.data.size).toBe(301)
    expect(storage.data.has('baselines:v1:o/r#0')).toBe(false)
    expect(storage.data.has('baselines:v1:o/r#4')).toBe(false)
    expect(storage.data.has('baselines:v1:o/r#5')).toBe(true)
  })
})
