import { expect, test } from 'vitest'
import type { PrDetail, PrFile } from '../model/types'
import {
  baseDocRef,
  decodeDocRef,
  docRefPrKey,
  encodeDocRef,
  headDocRef,
  viewedDocRef,
} from './docRef'

const detail: Pick<PrDetail, 'summary' | 'mergeBaseOid'> = {
  summary: {
    id: 'PR_1',
    repo: 'acme/app',
    number: 150,
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
  mergeBaseOid: 'merge-base-1',
}

function fullDetail(): PrDetail {
  return {
    ...detail,
    baseRefOid: 'base-1',
    files: [],
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
      viewerDidAuthor: false,
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

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    path: 'src/new.ts',
    previousPath: undefined,
    status: 'modified',
    additions: 1,
    deletions: 1,
    viewedState: 'UNVIEWED',
    blobSha: 'blob-1',
    patch: undefined,
    ...overrides,
  }
}

test('a reference survives the round trip through the query of a URI', () => {
  const ref = headDocRef(fullDetail(), file())
  expect(decodeDocRef(encodeDocRef(ref))).toEqual(ref)
  expect(docRefPrKey(ref)).toBe('acme/app#150')
})

test('the same version always gives the same query', () => {
  const a = encodeDocRef({ repo: 'a/b', pr: 1, path: 'x', side: 'head', blob: 's' })
  const b = encodeDocRef({ blob: 's', side: 'head', path: 'x', pr: 1, repo: 'a/b' })
  expect(a).toBe(b)
})

test('rejects queries that are not a reference', () => {
  expect(decodeDocRef('')).toBeUndefined()
  expect(decodeDocRef('not json')).toBeUndefined()
  expect(decodeDocRef('{"repo":"a/b"}')).toBeUndefined()
})

test('the head side is addressed by blob, or by commit when the blob is unknown', () => {
  expect(headDocRef(fullDetail(), file())).toMatchObject({ side: 'head', blob: 'blob-1' })
  expect(headDocRef(fullDetail(), file({ blobSha: undefined }))).toMatchObject({
    side: 'head',
    commit: 'head-1',
    srcPath: 'src/new.ts',
  })
  expect(headDocRef(fullDetail(), file({ status: 'removed', blobSha: undefined })).side).toBe(
    'empty',
  )
})

test('the base side reads the previous path of a renamed file at the merge base', () => {
  expect(
    baseDocRef(fullDetail(), file({ status: 'renamed', previousPath: 'src/old.ts' })),
  ).toMatchObject({ side: 'base', commit: 'merge-base-1', srcPath: 'src/old.ts' })
  expect(baseDocRef(fullDetail(), file({ status: 'added' })).side).toBe('empty')
})

test('the viewed side reads the blob of the baseline', () => {
  expect(
    viewedDocRef(fullDetail(), file(), { blob: 'blob-0', commit: 'head-0', at: 1 }),
  ).toMatchObject({ side: 'viewed', blob: 'blob-0' })
  expect(
    viewedDocRef(fullDetail(), file(), { blob: 'removed', commit: 'head-0', at: 1 }).side,
  ).toBe('empty')
})
