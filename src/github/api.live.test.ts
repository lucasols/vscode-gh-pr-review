import { describe, expect, test } from 'vitest'
import { gitBlobSha } from '../util/gitBlobHash'
import { GitHubApi } from './api'
import { GitHubClient } from './client'

/**
 * Read-only checks against the real GitHub API. They only run when a token is
 * given: `GH_PR_REVIEW_LIVE_TOKEN=$(gh auth token) pnpm vitest run src/github/api.live.test.ts`
 */
const token = process.env.GH_PR_REVIEW_LIVE_TOKEN
const repo = { owner: 'microsoft', name: 'vscode-pull-request-github' }

describe.skipIf(!token)('GitHub API (live, read-only)', () => {
  const api = new GitHubApi(
    new GitHubClient(
      { getToken: () => Promise.resolve(token), onUnauthorized: () => undefined },
      (message) => console.info(message),
    ),
  )

  test('lists pull requests and loads one as a consistent snapshot', async () => {
    const lists = await api.fetchLists(repo, [
      { label: 'All Open', query: 'is:open' },
      { label: 'Merged', query: 'is:merged' },
    ])
    expect(lists.viewer).not.toBe('')
    expect(lists.categories.map((c) => c.label)).toEqual(['All Open', 'Merged'])

    const open = lists.categories[0]?.prs ?? []
    expect(open.length).toBeGreaterThan(0)
    for (const pr of open) {
      expect(pr.repo).toBe('microsoft/vscode-pull-request-github')
      expect(pr.state).toBe('OPEN')
    }

    const first = open[0]
    if (!first) throw new Error('no open pull request')

    const { detail, cache } = await api.fetchDetail({ ...repo, number: first.number }, undefined)
    expect(detail.summary.number).toBe(first.number)
    expect(detail.files.length).toBeGreaterThan(0)
    expect(detail.mergeBaseOid).toMatch(/^[0-9a-f]{40}$/)
    expect(cache.key).toBe(`${detail.summary.headRefOid}:${detail.baseRefOid}`)

    // the blob of every file that still exists must be known, the feature
    // that shows the changes since a file was viewed depends on it
    for (const file of detail.files) {
      if (file.status === 'removed') expect(file.blobSha).toBeUndefined()
      else expect(file.blobSha, file.path).toMatch(/^[0-9a-f]{40}$/)
    }

    // a second load reuses the cached diff
    const again = await api.fetchDetail({ ...repo, number: first.number }, cache)
    expect(again.cache).toBe(cache)

    const file = detail.files.find((f) => f.blobSha && f.status === 'modified')
    if (file?.blobSha) {
      const head = await api.readBlob(repo, file.blobSha)
      expect(head && gitBlobSha(head)).toBe(file.blobSha)

      const base = await api.readFileAtCommit(repo, detail.mergeBaseOid, file.path)
      expect(base?.byteLength).toBeGreaterThan(0)
      expect(base && gitBlobSha(base)).not.toBe(file.blobSha)

      const commits = await api.fetchCommitsTouchingPath(
        repo,
        detail.summary.headRefOid,
        file.path,
      )
      expect(commits.length).toBeGreaterThan(0)
    }

    const missing = await api.readFileAtCommit(repo, detail.mergeBaseOid, 'does/not/exist.ts')
    expect(missing).toBeUndefined()

    const commits = await api.fetchCommits({ ...repo, number: first.number })
    expect(commits.at(-1)?.oid).toBe(detail.summary.headRefOid)

    console.info(
      JSON.stringify(
        {
          pr: detail.summary.number,
          files: detail.files.length,
          statuses: [...new Set(detail.files.map((f) => f.status))],
          threads: detail.threads.length,
          checks: detail.overview.checks.length,
          timeline: detail.overview.timeline.length,
          reviewers: detail.overview.reviewers,
          mergeMethods: detail.overview.allowedMergeMethods,
        },
        null,
        2,
      ),
    )
  }, 60_000)

  test('a merged pull request still has a diff', async () => {
    const lists = await api.fetchLists(repo, [{ label: 'Merged', query: 'is:merged' }])
    const merged = lists.categories[0]?.prs[0]
    if (!merged) throw new Error('no merged pull request')

    const { detail } = await api.fetchDetail({ ...repo, number: merged.number }, undefined)
    expect(detail.summary.state).toBe('MERGED')
    expect(detail.files.length).toBeGreaterThan(0)
    expect(detail.mergeBaseOid).not.toBe(detail.summary.headRefOid)
    console.info(
      JSON.stringify({
        pr: merged.number,
        base: detail.baseRefOid,
        mergeBase: detail.mergeBaseOid,
        head: detail.summary.headRefOid,
      }),
    )
  }, 60_000)

  test('finds the pull request of a branch', async () => {
    const lists = await api.fetchLists(repo, [{ label: 'All Open', query: 'is:open' }])
    const pr = lists.categories[0]?.prs.find((p) => !p.isCrossRepository)
    if (!pr) return

    const prs = await api.fetchBranchPrs(repo, pr.headRefName)
    expect(prs.map((p) => p.number)).toContain(pr.number)
  }, 60_000)

  test('loads the labels and the reviewers that a pull request can get', async () => {
    const labels = await api.fetchLabels(repo)
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) expect(label.color).toMatch(/^[0-9a-f]{6}$/i)

    // the teams of a repository are only listed to who can see them
    const reviewers = await api.fetchReviewerOptions(repo)
    const users = reviewers.filter((reviewer) => reviewer.kind === 'user')
    expect(users.length).toBeGreaterThan(0)
    expect(new Set(users.map((user) => user.slug)).size).toBe(users.length)
    console.info(JSON.stringify({ labels: labels.length, reviewers: reviewers.length }))
  }, 60_000)

  test('a missing pull request is reported as not found', async () => {
    await expect(api.fetchDetail({ ...repo, number: 99999999 }, undefined)).rejects.toMatchObject({
      kind: 'notFound',
    })
  }, 60_000)
})
