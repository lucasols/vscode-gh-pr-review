import { expect, test, vi } from 'vitest'
import type { DocRef } from '../content/docRef'
import { ChangeClassifier } from './changeClassifier'
import type { PrDetail, PrFile } from './types'

const detail: PrDetail = {
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
    headRefOid: 'head-2',
    headRepoOwner: 'acme',
    isCrossRepository: false,
    reviewDecision: undefined,
    checkState: 'NONE',
  },
  baseRefOid: 'base-1',
  mergeBaseOid: 'merge-base-1',
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

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    path: 'src/a.ts',
    previousPath: undefined,
    status: 'modified',
    additions: 1,
    deletions: 1,
    viewedState: 'UNVIEWED',
    blobSha: 'blob-2',
    patch: "@@ -1 +1 @@\n-import { a } from './a'\n+import { a } from './b'",
    ...overrides,
  }
}

const CODE = 'export const x = 1\n'

function createClassifier(contents: Record<string, string>) {
  const readText = vi.fn((ref: DocRef) => {
    const key = ref.blob ?? `${ref.commit}:${ref.srcPath}`
    const content = contents[key]
    return content === undefined ?
        Promise.reject(new Error(`no content for ${key}`))
      : Promise.resolve(content)
  })
  const classifier = new ChangeClassifier({ readText }, () => undefined)
  const settled = () =>
    new Promise<void>((resolve) => {
      const subscription = classifier.onDidChange(() => {
        subscription.dispose()
        resolve()
      })
    })
  return { classifier, readText, settled }
}

test('a renamed file without content changes is rename only, without reading content', () => {
  const { classifier, readText } = createClassifier({})
  const renamed = file({
    path: 'src/new.ts',
    previousPath: 'src/old.ts',
    status: 'renamed',
    additions: 0,
    deletions: 0,
    patch: undefined,
  })

  expect(classifier.classify(detail, renamed, undefined)).toBe('renameOnly')
  expect(readText).not.toHaveBeenCalled()
})

test('a renamed file whose imports changed is imports only, compared with the old path', async () => {
  const { classifier, settled } = createClassifier({
    'merge-base-1:src/old.ts': `import { a } from './a'\n${CODE}`,
    'blob-2': `import { a } from './b'\n${CODE}`,
  })
  const renamed = file({ path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed' })

  expect(classifier.classify(detail, renamed, undefined)).toBeUndefined()
  await settled()
  expect(classifier.classify(detail, renamed, undefined)).toBe('importsOnly')
})

test('the patch rules out code changes without reading content', () => {
  const { classifier, readText } = createClassifier({})
  const changed = file({ patch: '@@ -1 +1 @@\n-const a = 1\n+const a = 2' })

  expect(classifier.classify(detail, changed, undefined)).toBe('relevant')
  expect(readText).not.toHaveBeenCalled()
})

test('the content has the last word when the patch looks like imports', async () => {
  // the changed line looks like a name of an import, but it is in an object
  const { classifier, settled } = createClassifier({
    'merge-base-1:src/a.ts': 'const o = {\n  a,\n}\n',
    'blob-2': 'const o = {\n  b,\n}\n',
  })
  const changed = file({ patch: '@@ -1,3 +1,3 @@\n const o = {\n-  a,\n+  b,\n }' })

  expect(classifier.classify(detail, changed, undefined)).toBeUndefined()
  await settled()
  expect(classifier.classify(detail, changed, undefined)).toBe('relevant')
})

test('with a baseline only the changes since the file was viewed count', async () => {
  const { classifier, settled, readText } = createClassifier({
    'blob-1': `import { a } from './a'\n${CODE}`,
    'blob-2': `import { a } from './b'\n${CODE}`,
  })
  // the whole diff has code changes, but only imports changed since it was viewed
  const changed = file({
    viewedState: 'DISMISSED',
    patch: '@@ -1 +1,2 @@\n-const old = 1\n+import { a } from "./b"\n+export const x = 1',
  })
  const baseline = { blob: 'blob-1', commit: 'head-1', at: 1 }

  expect(classifier.classify(detail, changed, baseline)).toBeUndefined()
  await settled()
  expect(classifier.classify(detail, changed, baseline)).toBe('importsOnly')
  expect(readText).toHaveBeenCalledTimes(2)
})

test('a rename is relevant when the file also changed since it was viewed', async () => {
  const { classifier, settled } = createClassifier({
    'blob-1': CODE,
    'blob-2': 'export const x = 2\n',
  })
  const renamed = file({
    status: 'renamed',
    previousPath: 'src/old.ts',
    additions: 0,
    deletions: 0,
    viewedState: 'DISMISSED',
  })
  const baseline = { blob: 'blob-1', commit: 'head-1', at: 1 }

  expect(classifier.classify(detail, renamed, baseline)).toBeUndefined()
  await settled()
  expect(classifier.classify(detail, renamed, baseline)).toBe('relevant')
})

test('a lockfile is never relevant, whatever happened to it', () => {
  const { classifier, readText } = createClassifier({})
  for (const status of ['added', 'modified', 'removed'] as const) {
    expect(
      classifier.classify(detail, file({ path: 'pnpm-lock.yaml', status }), undefined),
    ).toBe('lockfile')
  }
  expect(readText).not.toHaveBeenCalled()
})

test('added, removed and non-script files are relevant', () => {
  const { classifier } = createClassifier({})
  expect(classifier.classify(detail, file({ status: 'added' }), undefined)).toBe('relevant')
  expect(
    classifier.classify(detail, file({ status: 'removed', blobSha: undefined }), undefined),
  ).toBe('relevant')
  expect(classifier.classify(detail, file({ path: 'README.md' }), undefined)).toBe('relevant')
})

test('content that cannot be read is treated as relevant', async () => {
  const { classifier, settled } = createClassifier({})
  expect(classifier.classify(detail, file(), undefined)).toBeUndefined()
  await settled()
  expect(classifier.classify(detail, file(), undefined)).toBe('relevant')
})
