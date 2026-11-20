import { describe, expect, test, vi } from 'vitest'
import type { DocRef } from '../content/docRef'
import type { Baseline } from './baselines'
import { LineReviews, LineReviewStore, isFullyReviewed, unreviewedLines } from './lineReviews'
import type { RecordStorage } from './prRecordStore'
import type { PrDetail, PrFile } from './types'

function createStorage(): RecordStorage {
  const data = new Map<string, unknown>()
  return {
    keys: () => [...data.keys()],
    get: (key) => data.get(key),
    update: (key, value) => {
      if (value === undefined) data.delete(key)
      else data.set(key, value)
      return Promise.resolve()
    },
  }
}

function makeDetail(files: PrFile[]): PrDetail {
  return {
    summary: {
      id: 'PR_1',
      repo: 'acme/app',
      number: 7,
      title: '',
      url: '',
      state: 'OPEN',
      isDraft: false,
      updatedAt: '',
      author: undefined,
      baseRefName: 'main',
      headRefName: 'feature',
      headRefOid: 'head-1',
      headRepoOwner: 'acme',
      isCrossRepository: false,
      reviewDecision: undefined,
      checkState: 'NONE',
    },
    baseRefOid: 'base-1',
    mergeBaseOid: 'merge-base-1',
    files,
    threads: [],
    pendingReview: undefined,
    overview: {
      bodyHtml: '',
      createdAt: '',
      additions: 0,
      deletions: 0,
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
      viewerCanUpdate: false,
      viewerCanLabel: false,
      viewerCanRequestReviews: false,
      viewerDidAuthor: false,
      viewerCanMerge: false,
      viewerCanMergeAsAdmin: false,
      viewerCanEnableAutoMerge: false,
      viewerCanDisableAutoMerge: false,
      autoMerge: undefined,
      mergedBy: undefined,
      labels: [],
      assignees: [],
      milestone: undefined,
      reviewers: [],
      checks: [],
      timeline: [],
      allowedMergeMethods: [],
      defaultMergeMethod: 'MERGE',
    },
  }
}

const BASE = 'a\nd\n'
// lines 2, 3 and 5 of the head version are new
const HEAD = 'a\nb\nc\nd\ne\n'

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    path: 'src/a.ts',
    previousPath: undefined,
    status: 'modified',
    additions: 3,
    deletions: 0,
    viewedState: 'UNVIEWED',
    blobSha: 'blob-1',
    patch: undefined,
    ...overrides,
  }
}

const r = (start: number, end: number) => ({ start, end })

function setup(contents: Record<string, string> = {}, preferSinceViewed = true) {
  const all: Record<string, string> = { base: BASE, 'blob-1': HEAD, ...contents }
  const readText = vi.fn((ref: DocRef) => {
    if (ref.side === 'empty') return Promise.resolve('')
    const key = ref.side === 'base' ? 'base' : ref.blob
    const text = key === undefined ? undefined : all[key]
    return text === undefined ?
        Promise.reject(new Error(`no content for ${key ?? ref.side}`))
      : Promise.resolve(text)
  })
  const records = new LineReviewStore(createStorage())
  let now = 1000
  const reviews = new LineReviews({
    records,
    content: { readText },
    preferSinceViewed: () => preferSinceViewed,
    now: () => now++,
    log: () => undefined,
  })
  const changes = vi.fn()
  reviews.onDidChange(changes)
  return { reviews, records, readText, changes }
}

describe('LineReviews', () => {
  test('the lines to review are the added lines, known once the versions are loaded', async () => {
    const { reviews, changes } = setup()
    const a = file()
    const detail = makeDetail([a])
    expect(reviews.get(detail, a, undefined)).toBeUndefined()

    const review = await reviews.load(detail, a, undefined)
    expect(changes).toHaveBeenCalledWith('acme/app#7')
    expect(review).toMatchObject({
      blob: 'blob-1',
      changed: [r(2, 3), r(5, 5)],
      reviewed: [],
      total: 3,
      reviewedCount: 0,
    })
    expect(reviews.get(detail, a, undefined)).toEqual(review)
  })

  test('marks only changed lines and stores them with the blob', async () => {
    const { reviews, records, changes } = setup()
    const a = file()
    const detail = makeDetail([a])

    const review = await reviews.setReviewed(detail, a, undefined, [r(1, 3)], true)

    expect(review?.reviewed).toEqual([r(2, 3)])
    expect(review && unreviewedLines(review)).toEqual([r(5, 5)])
    expect(review && isFullyReviewed(review)).toBe(false)
    expect(records.get('acme/app#7')).toEqual({
      'src/a.ts': { blob: 'blob-1', lines: [r(2, 3)], at: 1000 },
    })
    expect(changes).toHaveBeenCalledWith('acme/app#7')

    const done = await reviews.setReviewed(detail, a, undefined, [r(4, 5)], true)
    expect(done && isFullyReviewed(done)).toBe(true)
  })

  test('the reviewed version has the reviewed changes applied', async () => {
    const { reviews } = setup()
    const a = file()
    const detail = makeDetail([a])
    expect(await reviews.reviewedText(detail, a, undefined)).toBe(BASE)

    await reviews.setReviewed(detail, a, undefined, [r(1, 3)], true)
    expect(await reviews.reviewedText(detail, a, undefined)).toBe('a\nb\nc\nd\n')

    const viewed = { ...a, viewedState: 'VIEWED' as const }
    expect(await reviews.reviewedText(makeDetail([viewed]), viewed, undefined)).toBe(HEAD)
  })

  test('unmarking removes the lines, and the record when none are left', async () => {
    const { reviews, records } = setup()
    const a = file()
    const detail = makeDetail([a])
    await reviews.setReviewed(detail, a, undefined, [r(1, 5)], true)

    const review = await reviews.setReviewed(detail, a, undefined, [r(3, 3)], false)
    expect(review?.reviewed).toEqual([r(2, 2), r(5, 5)])

    await reviews.setReviewed(detail, a, undefined, [r(1, 5)], false)
    expect(records.get('acme/app#7')).toEqual({})
    expect(reviews.hasReviewedLines('acme/app#7', 'src/a.ts')).toBe(false)
  })

  test('viewed and removed files are not reviewed line by line', async () => {
    const { reviews } = setup()
    const viewed = file({ viewedState: 'VIEWED' })
    const removed = file({ path: 'b.ts', status: 'removed', blobSha: undefined })
    const detail = makeDetail([viewed, removed])
    expect(await reviews.load(detail, viewed, undefined)).toBeUndefined()
    expect(await reviews.load(detail, removed, undefined)).toBeUndefined()
  })

  test('a file whose content did not change has nothing to review line by line', async () => {
    const { reviews } = setup({ 'blob-9': BASE })
    const renamed = file({ status: 'renamed', previousPath: 'old.ts', blobSha: 'blob-9' })
    expect(await reviews.load(makeDetail([renamed]), renamed, undefined)).toBeUndefined()
  })

  test('after a push the reviewed lines that did not change stay reviewed', async () => {
    const { reviews, changes } = setup({ 'blob-2': 'a\nb\nC\nd\ne\n' })
    const before = file()
    await reviews.setReviewed(makeDetail([before]), before, undefined, [r(1, 5)], true)

    const after = file({ blobSha: 'blob-2' })
    const detail = makeDetail([after])
    changes.mockClear()

    expect(reviews.get(detail, after, undefined)).toBeUndefined()
    const review = await reviews.load(detail, after, undefined)

    expect(changes).toHaveBeenCalledWith('acme/app#7')
    expect(review?.reviewed).toEqual([r(2, 2), r(5, 5)])
    expect(reviews.get(detail, after, undefined)?.reviewed).toEqual([r(2, 2), r(5, 5)])
  })

  test('a file that changed after it was viewed only has the new changes to review', async () => {
    const contents = { 'blob-2': 'a\nb\nc\nd\ne\nf\n' }
    const baseline: Baseline = { blob: 'blob-1', commit: 'head-1', at: 1 }
    const changed = file({ blobSha: 'blob-2' })

    const sinceViewed = setup(contents)
    expect(await sinceViewed.reviews.load(makeDetail([changed]), changed, baseline)).toMatchObject(
      { changed: [r(6, 6)], total: 1 },
    )

    // when the full diff is the default, the whole diff is reviewed
    const full = setup(contents, false)
    expect(await full.reviews.load(makeDetail([changed]), changed, baseline)).toMatchObject({
      total: 4,
    })
  })

  test('binary files are not reviewed line by line', async () => {
    const { reviews } = setup({ 'blob-2': 'PNG\u0000' })
    const image = file({ path: 'logo.png', status: 'added', blobSha: 'blob-2' })
    expect(await reviews.load(makeDetail([image]), image, undefined)).toBeUndefined()
  })

  test('drops the records of files that were viewed since', async () => {
    const { reviews, records } = setup()
    const a = file()
    const b = file({ path: 'src/b.ts' })
    await reviews.setReviewed(makeDetail([a, b]), a, undefined, [r(2, 2)], true)

    const viewedA = { ...a, viewedState: 'VIEWED' as const }
    await reviews.setReviewed(makeDetail([viewedA, b]), b, undefined, [r(2, 2)], true)

    expect(Object.keys(records.get('acme/app#7'))).toEqual(['src/b.ts'])
  })

  test('forgets the reviewed lines of files that are fully reviewed', async () => {
    const { reviews, records, changes } = setup()
    const a = file()
    const b = file({ path: 'src/b.ts' })
    await reviews.setReviewed(makeDetail([a, b]), a, undefined, [r(2, 2)], true)
    await reviews.setReviewed(makeDetail([a, b]), b, undefined, [r(2, 2)], true)
    changes.mockClear()

    reviews.forgetFinished(makeDetail([a, b]))
    expect(changes).not.toHaveBeenCalled()

    reviews.forgetFinished(makeDetail([{ ...a, viewedState: 'VIEWED' }, b]))
    expect(Object.keys(records.get('acme/app#7'))).toEqual(['src/b.ts'])
    expect(changes).toHaveBeenCalledWith('acme/app#7')
  })

  test('the reviewed version of an older head carries the lines reviewed in a newer one', async () => {
    const { reviews } = setup({ 'blob-2': 'a\nb\nC\nd\ne\n' })
    const newer = file({ blobSha: 'blob-2' })
    await reviews.setReviewed(makeDetail([newer]), newer, undefined, [r(1, 5)], true)

    // a diff that was opened before the push still shows blob-1
    const older = file()
    expect(await reviews.reviewedText(makeDetail([newer]), older, undefined)).toBe(
      'a\nb\nd\ne\n',
    )
  })
})
