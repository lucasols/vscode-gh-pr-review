import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { DiffCache } from '../github/api'
import { GitHubError } from '../github/client'
import { BASELINE_SETTLE_MS, BaselineStore, type BaselineStorage } from './baselines'
import { PrStore, type LocalRepo, type StoreApi } from './prStore'
import type { PrDetail, PrFile, PrSummary, ViewedState } from './types'

const KEY = 'acme/app#150'

function summary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: 'PR_150',
    repo: 'acme/app',
    number: 150,
    title: 'Add the builder agent',
    url: 'https://github.com/acme/app/pull/150',
    state: 'OPEN',
    isDraft: false,
    updatedAt: '2026-11-16T10:00:00Z',
    author: { login: 'lucasols', avatarUrl: undefined },
    baseRefName: 'main',
    headRefName: 'feature/builder',
    headRefOid: 'head-1',
    headRepoOwner: 'acme',
    isCrossRepository: false,
    reviewDecision: undefined,
    checkState: 'SUCCESS',
    ...overrides,
  }
}

function file(path: string, viewedState: ViewedState, blobSha: string): PrFile {
  return {
    path,
    previousPath: undefined,
    status: 'modified',
    additions: 1,
    deletions: 1,
    viewedState,
    blobSha,
    patch: '@@ -1 +1 @@\n-a\n+b',
  }
}

function detail(files: PrFile[], overrides: Partial<PrSummary> = {}): PrDetail {
  return {
    summary: summary(overrides),
    baseRefOid: 'base-1',
    mergeBaseOid: 'merge-base-1',
    files,
    threads: [],
    pendingReview: undefined,
    overview: {
      bodyHtml: '',
      createdAt: '2026-11-15T10:00:00Z',
      additions: 1,
      deletions: 1,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      viewerCanUpdate: true,
      viewerDidAuthor: true,
      mergedBy: undefined,
      labels: [],
      assignees: [],
      milestone: undefined,
      reviewers: [],
      checks: [],
      timeline: [],
      allowedMergeMethods: ['SQUASH'],
      defaultMergeMethod: 'SQUASH',
    },
  }
}

const repo: LocalRepo = {
  rootPath: '/work/app',
  github: { owner: 'acme', name: 'app' },
  remotes: [{ name: 'origin', repo: { owner: 'acme', name: 'app' } }],
  branch: 'feature/builder',
  headSha: 'head-1',
}

function createHarness() {
  /** What GitHub has. The tests change it to simulate pushes */
  const remote = {
    detail: detail([
      file('a.ts', 'UNVIEWED', 'blob-a1'),
      file('b.ts', 'UNVIEWED', 'blob-b1'),
    ]),
    branchPrs: [summary()],
  }
  let now = 1_000_000
  const notifications: string[] = []
  const data = new Map<string, unknown>()
  const storage: BaselineStorage = {
    keys: () => [...data.keys()],
    get: (key) => data.get(key),
    update: (key, value) => {
      if (value === undefined) data.delete(key)
      else data.set(key, value)
      return Promise.resolve()
    },
  }
  let persistedFocus: string | undefined

  function setRemoteViewed(paths: readonly string[], viewed: boolean) {
    remote.detail = {
      ...remote.detail,
      files: remote.detail.files.map((f) =>
        paths.includes(f.path) ? { ...f, viewedState: viewed ? 'VIEWED' : 'UNVIEWED' } : f,
      ),
    }
  }

  const unused = () => Promise.reject(new Error('not used in this test'))

  const api = {
    fetchLists: vi.fn<StoreApi['fetchLists']>(() =>
      Promise.resolve({
        viewer: 'lucasols',
        categories: [
          { label: 'All Open', query: 'is:open', totalCount: 1, prs: [remote.detail.summary] },
        ],
      }),
    ),
    fetchBranchPrs: vi.fn<StoreApi['fetchBranchPrs']>(() =>
      Promise.resolve(remote.branchPrs),
    ),
    fetchDetail: vi.fn<StoreApi['fetchDetail']>((_ref, cache) => {
      const key = `${remote.detail.summary.headRefOid}:${remote.detail.baseRefOid}`
      const next: DiffCache =
        cache?.key === key ? cache : { key, restFiles: [], mergeBaseOid: 'merge-base-1' }
      return Promise.resolve({ detail: remote.detail, cache: next })
    }),
    setFilesViewed: vi.fn<StoreApi['setFilesViewed']>((_id, paths, viewed) => {
      setRemoteViewed(paths, viewed)
      return Promise.resolve(remote.detail.summary.headRefOid)
    }),
    addThread: vi.fn<StoreApi['addThread']>(() =>
      Promise.resolve({
        id: 'C1',
        state: 'PENDING',
        pullRequestReview: { id: 'R1', state: 'PENDING' },
      }),
    ),
    addThreadReply: vi.fn<StoreApi['addThreadReply']>(() =>
      Promise.resolve({
        id: 'C2',
        state: 'PENDING',
        pullRequestReview: { id: 'R1', state: 'PENDING' },
      }),
    ),
    submitReview: vi.fn<StoreApi['submitReview']>(() => Promise.resolve()),
    addReview: vi.fn<StoreApi['addReview']>(() => Promise.resolve('R2')),
    merge: vi.fn<StoreApi['merge']>(() => Promise.resolve()),
    fetchCommits: vi.fn<StoreApi['fetchCommits']>(unused),
    fetchCommitsTouchingPath: vi.fn<StoreApi['fetchCommitsTouchingPath']>(unused),
    deleteReview: vi.fn<StoreApi['deleteReview']>(unused),
    updateComment: vi.fn<StoreApi['updateComment']>(unused),
    deleteComment: vi.fn<StoreApi['deleteComment']>(unused),
    setThreadResolved: vi.fn<StoreApi['setThreadResolved']>(unused),
    addIssueComment: vi.fn<StoreApi['addIssueComment']>(unused),
    markReadyForReview: vi.fn<StoreApi['markReadyForReview']>(unused),
  } satisfies StoreApi

  const store = new PrStore({
    api,
    baselines: new BaselineStore(storage),
    getQueries: () => [{ label: 'All Open', query: 'is:open' }],
    notify: (level, message) => notifications.push(`${level}: ${message}`),
    log: () => undefined,
    now: () => now,
    persistedFocus: {
      get: () => persistedFocus,
      set: (key) => {
        persistedFocus = key
      },
    },
  })

  return {
    store,
    api,
    remote,
    notifications,
    advance: (ms: number) => {
      now += ms
    },
    /** Simulates a push that changes the content of files */
    push: (head: string, blobs: Record<string, string>) => {
      remote.detail = {
        ...remote.detail,
        summary: { ...remote.detail.summary, headRefOid: head },
        files: remote.detail.files.map((f) => {
          const blob = blobs[f.path]
          if (blob === undefined) return f
          return {
            ...f,
            blobSha: blob,
            // GitHub dismisses the viewed state of a file that changes
            viewedState: f.viewedState === 'VIEWED' ? 'DISMISSED' : f.viewedState,
          }
        }),
      }
    },
    getPersistedFocus: () => persistedFocus,
    viewedStates: () =>
      Object.fromEntries(
        (store.getDetail(KEY)?.files ?? []).map((f) => [f.path, f.viewedState]),
      ),
  }
}

let h: ReturnType<typeof createHarness>

beforeEach(() => {
  h = createHarness()
})

describe('status and lists', () => {
  test('goes from loading to ready and focuses the pull request of the branch', async () => {
    expect(h.store.status).toBe('loading')
    h.store.setRepos([repo])
    expect(h.store.status).toBe('ready')

    await h.store.refreshAll()

    expect(h.store.getLists('/work/app')?.categories[0]?.prs).toHaveLength(1)
    expect(h.store.getCheckedOut('/work/app')?.number).toBe(150)
    expect(h.store.focusedKey).toBe(KEY)
    expect(h.getPersistedFocus()).toBe(KEY)
    expect(h.store.getDetail(KEY)?.files).toHaveLength(2)
    expect(h.store.viewer).toBe('lucasols')
  })

  test('reports no repository when the workspace has none', () => {
    h.store.setRepos([])
    expect(h.store.status).toBe('noRepo')
  })

  test('becomes signed out when GitHub rejects the credentials, and keeps the last data', async () => {
    h.store.setRepos([repo])
    await h.store.refreshAll()

    h.api.fetchLists.mockRejectedValueOnce(new GitHubError('Bad credentials', 'auth', 401))
    await h.store.refreshLists()

    expect(h.store.status).toBe('signedOut')
    expect(h.store.getLists('/work/app')?.categories[0]?.prs).toHaveLength(1)

    await h.store.refreshLists()
    expect(h.store.status).toBe('ready')
  })

  test('keeps the last list when a refresh fails', async () => {
    h.store.setRepos([repo])
    await h.store.refreshAll()

    h.api.fetchLists.mockRejectedValueOnce(new GitHubError('Could not reach GitHub', 'network'))
    await h.store.refreshLists()

    const lists = h.store.getLists('/work/app')
    expect(lists?.error).toBe('Could not reach GitHub')
    expect(lists?.categories[0]?.prs).toHaveLength(1)
    expect(h.store.status).toBe('ready')
  })

  test('only announces a change when the data changed', async () => {
    h.store.setRepos([repo])
    await h.store.refreshAll()

    const listChanges = vi.fn()
    const detailChanges = vi.fn()
    h.store.onDidChangeLists(listChanges)
    h.store.onDidChangeDetail(detailChanges)

    await h.store.refreshAll()
    await h.store.refreshAll()
    expect(listChanges).not.toHaveBeenCalled()
    expect(detailChanges).not.toHaveBeenCalled()

    h.push('head-2', { 'a.ts': 'blob-a2' })
    await h.store.refreshAll()
    expect(listChanges).toHaveBeenCalledTimes(1)
    expect(detailChanges).toHaveBeenCalledTimes(1)
  })

  test('ignores a pull request of another fork that has the same branch name', async () => {
    h.remote.branchPrs = [
      summary({ number: 7, isCrossRepository: true, headRepoOwner: 'stranger' }),
    ]
    h.store.setRepos([{ ...repo, headSha: 'local-1' }])
    await h.store.refreshAll()

    expect(h.store.getCheckedOut('/work/app')).toBeUndefined()
    expect(h.store.focusedKey).toBeUndefined()
  })

  test('finds the pull request of a fork by its commit, because its local branch has another name', async () => {
    h.remote.branchPrs = []
    h.store.setRepos([{ ...repo, branch: 'pr/stranger/150', headSha: 'head-1' }])
    await h.store.refreshAll()

    expect(h.store.getCheckedOut('/work/app')?.number).toBe(150)
    expect(h.store.focusedKey).toBe(KEY)
  })
})

describe('focus', () => {
  test('switching to a branch with a pull request focuses it', async () => {
    h.store.setRepos([{ ...repo, branch: 'main', headSha: 'main-1' }])
    h.remote.branchPrs = []
    await h.store.refreshAll()
    expect(h.store.focusedKey).toBeUndefined()

    h.store.focus('acme/app#7')
    h.remote.branchPrs = [summary()]
    h.store.setRepos([repo])
    await h.store.refreshAll()

    expect(h.store.focusedKey).toBe(KEY)
  })

  test('a refresh without a branch change keeps the pull request that the user picked', async () => {
    h.store.setRepos([repo])
    await h.store.refreshAll()

    h.store.focus('acme/app#7')
    await h.store.refreshAll()
    h.store.setRepos([{ ...repo, headSha: 'head-2' }])
    await h.store.refreshAll()

    expect(h.store.focusedKey).toBe('acme/app#7')
  })
})

describe('setViewed', () => {
  beforeEach(async () => {
    h.store.setRepos([repo])
    await h.store.refreshAll()
  })

  test('shows the change at once, saves it and records the version that was viewed', async () => {
    const promise = h.store.setViewed(KEY, ['a.ts'], true)
    expect(h.viewedStates()).toEqual({ 'a.ts': 'VIEWED', 'b.ts': 'UNVIEWED' })

    await promise

    expect(h.api.setFilesViewed).toHaveBeenCalledWith('PR_150', ['a.ts'], true)
    expect(h.viewedStates()).toEqual({ 'a.ts': 'VIEWED', 'b.ts': 'UNVIEWED' })
    expect(h.store.getBaselines(KEY)['a.ts']).toMatchObject({
      blob: 'blob-a1',
      commit: 'head-1',
    })
    expect(h.notifications).toEqual([])
  })

  test('skips the files that already have the wanted state', async () => {
    await h.store.setViewed(KEY, ['a.ts'], true)
    h.api.setFilesViewed.mockClear()

    await h.store.setViewed(KEY, ['a.ts', 'b.ts'], true)

    expect(h.api.setFilesViewed).toHaveBeenCalledWith('PR_150', ['b.ts'], true)
  })

  test('reverts and reports when GitHub rejects the change', async () => {
    h.api.setFilesViewed.mockRejectedValueOnce(new GitHubError('Server error (500)', 'api'))

    await h.store.setViewed(KEY, ['a.ts'], true)

    expect(h.viewedStates()['a.ts']).toBe('UNVIEWED')
    expect(h.store.getBaselines(KEY)['a.ts']).toBeUndefined()
    expect(h.notifications).toEqual([
      'error: Could not mark the file as viewed: Server error (500)',
    ])
  })

  test('unmarking removes the baseline', async () => {
    await h.store.setViewed(KEY, ['a.ts'], true)
    await h.store.setViewed(KEY, ['a.ts'], false)

    expect(h.viewedStates()['a.ts']).toBe('UNVIEWED')
    expect(h.store.getBaselines(KEY)['a.ts']).toBeUndefined()
  })

  test('after a push the baseline still points to the version that was viewed', async () => {
    await h.store.setViewed(KEY, ['a.ts', 'b.ts'], true)

    h.advance(60_000)
    h.push('head-2', { 'a.ts': 'blob-a2' })
    await h.store.refreshAll()

    expect(h.viewedStates()).toEqual({ 'a.ts': 'DISMISSED', 'b.ts': 'VIEWED' })
    expect(h.store.getBaselines(KEY)['a.ts']?.blob).toBe('blob-a1')

    // viewing the new version moves the baseline
    await h.store.setViewed(KEY, ['a.ts'], true)
    expect(h.store.getBaselines(KEY)['a.ts']).toMatchObject({
      blob: 'blob-a2',
      commit: 'head-2',
    })
  })

  test('a push that lands while a file is marked leaves the file as not viewed with the old baseline', async () => {
    // the push happens after the tree was loaded and before the click
    h.push('head-2', { 'a.ts': 'blob-a2' })

    await h.store.setViewed(KEY, ['a.ts', 'b.ts'], true)

    expect(h.api.setFilesViewed).toHaveBeenLastCalledWith('PR_150', ['a.ts'], false)
    expect(h.viewedStates()).toEqual({ 'a.ts': 'UNVIEWED', 'b.ts': 'VIEWED' })
    expect(h.store.getBaselines(KEY)['a.ts']?.blob).toBe('blob-a1')
    expect(h.store.getBaselines(KEY)['b.ts']?.blob).toBe('blob-b1')
    expect(h.notifications).toEqual([
      'warning: a.ts changed while it was marked as viewed, so it was left as not viewed.',
    ])
  })

  test('records a baseline for files that were marked as viewed outside the extension', async () => {
    h.remote.detail = {
      ...h.remote.detail,
      files: [file('a.ts', 'VIEWED', 'blob-a1'), file('b.ts', 'UNVIEWED', 'blob-b1')],
    }
    await h.store.refreshDetail(KEY)
    expect(h.store.getBaselines(KEY)['a.ts']?.blob).toBe('blob-a1')

    h.advance(BASELINE_SETTLE_MS * 2)
    h.push('head-2', { 'a.ts': 'blob-a2' })
    await h.store.refreshDetail(KEY)

    expect(h.viewedStates()['a.ts']).toBe('DISMISSED')
    expect(h.store.getBaselines(KEY)['a.ts']?.blob).toBe('blob-a1')
  })
})

describe('comments and reviews', () => {
  beforeEach(async () => {
    h.store.setRepos([repo])
    await h.store.refreshAll()
  })

  const target = {
    kind: 'thread',
    path: 'a.ts',
    line: 3,
    startLine: undefined,
    side: 'RIGHT',
  } as const

  test('a single comment publishes the review that GitHub starts for it', async () => {
    await h.store.addComment(KEY, target, 'Looks wrong', 'single')

    expect(h.api.addThread).toHaveBeenCalledWith({
      pullRequestId: 'PR_150',
      pullRequestReviewId: undefined,
      path: 'a.ts',
      body: 'Looks wrong',
      line: 3,
      startLine: undefined,
      side: 'RIGHT',
    })
    expect(h.api.submitReview).toHaveBeenCalledWith({
      pullRequestReviewId: 'R1',
      event: 'COMMENT',
      body: undefined,
    })
  })

  test('a review comment stays pending', async () => {
    await h.store.addComment(KEY, target, 'Looks wrong', 'review')
    expect(h.api.submitReview).not.toHaveBeenCalled()
  })

  test('a comment joins the pending review instead of publishing it', async () => {
    h.remote.detail = { ...h.remote.detail, pendingReview: { id: 'R9', commentCount: 2 } }
    await h.store.refreshDetail(KEY)

    await h.store.addComment(KEY, { kind: 'reply', threadId: 'T1' }, 'Agreed', 'single')

    expect(h.api.addThreadReply).toHaveBeenCalledWith({
      threadId: 'T1',
      pullRequestReviewId: 'R9',
      body: 'Agreed',
    })
    expect(h.api.submitReview).not.toHaveBeenCalled()
  })

  test('submitting uses the pending review when there is one', async () => {
    await h.store.submitReview(KEY, 'APPROVE', '  ')
    expect(h.api.addReview).toHaveBeenCalledWith({
      pullRequestId: 'PR_150',
      event: 'APPROVE',
      body: undefined,
    })

    h.remote.detail = { ...h.remote.detail, pendingReview: { id: 'R9', commentCount: 2 } }
    await h.store.refreshDetail(KEY)
    await h.store.submitReview(KEY, 'REQUEST_CHANGES', 'Please fix')
    expect(h.api.submitReview).toHaveBeenCalledWith({
      pullRequestReviewId: 'R9',
      event: 'REQUEST_CHANGES',
      body: 'Please fix',
    })
  })

  test('a merge is tied to the commit that was loaded', async () => {
    await h.store.merge(KEY, 'SQUASH')
    expect(h.api.merge).toHaveBeenCalledWith({
      pullRequestId: 'PR_150',
      mergeMethod: 'SQUASH',
      expectedHeadOid: 'head-1',
    })
  })
})
