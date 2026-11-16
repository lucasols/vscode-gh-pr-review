import type {
  DiffSide,
  MergeMethod,
  PrDetail,
  PrRef,
  PrSummary,
  ReviewEvent,
} from '../model/types'
import { chunk } from '../util/async'
import { repoKey, type RepoRef } from '../util/remoteUrl'
import { GitHubError, type GitHubClient } from './client'
import {
  ADD_ISSUE_COMMENT_MUTATION,
  ADD_REVIEW_MUTATION,
  ADD_THREAD_MUTATION,
  ADD_THREAD_REPLY_MUTATION,
  BRANCH_PRS_QUERY,
  DELETE_COMMENT_MUTATION,
  DELETE_REVIEW_MUTATION,
  DISABLE_AUTO_MERGE_MUTATION,
  ENABLE_AUTO_MERGE_MUTATION,
  MERGE_MUTATION,
  PR_COMMITS_QUERY,
  PR_DETAIL_QUERY,
  PR_FILES_PAGE_QUERY,
  PR_HEAD_QUERY,
  PR_THREADS_PAGE_QUERY,
  READY_FOR_REVIEW_MUTATION,
  RESOLVE_THREAD_MUTATION,
  SUBMIT_REVIEW_MUTATION,
  UNRESOLVE_THREAD_MUTATION,
  UPDATE_COMMENT_MUTATION,
  VIEWER_QUERY,
  buildListsQuery,
  buildSetViewedMutation,
} from './queries'
import {
  addReviewSchema,
  addThreadReplySchema,
  addThreadSchema,
  anyMutationSchema,
  branchPrsSchema,
  listsSchema,
  parsePrSummaries,
  parseSearchResult,
  prCommitsSchema,
  prDetailSchema,
  prFilesPageSchema,
  prHeadSchema,
  prThreadsPageSchema,
  restCommitsSchema,
  restCompareSchema,
  restFilesSchema,
  setViewedSchema,
  toPendingReview,
  toPrFiles,
  toPrOverview,
  toPrSummary,
  toReviewThread,
  viewerSchema,
  type CommentResult,
  type RawChangedFile,
  type RawThread,
  type RestFile,
} from './schemas'

export type ListQuery = { label: string; query: string }

export type PrCategory = {
  label: string
  query: string
  totalCount: number
  prs: PrSummary[]
}

/**
 * The parts of a pull request that only change when its commits change. They
 * are kept between refreshes so that a refresh costs a single request.
 */
export type DiffCache = {
  key: string
  restFiles: RestFile[]
  mergeBaseOid: string
}

export type PrCommit = {
  oid: string
  abbreviatedOid: string
  message: string
  committedDate: string
}

const MAX_DETAIL_ATTEMPTS = 3
const MAX_REST_FILE_PAGES = 30

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export function buildSearchQuery(repo: RepoRef, query: string): string {
  const parts = [`repo:${repoKey(repo)}`, 'is:pr', query.trim()]
  if (!/(^|\s)sort:/.test(query)) parts.push('sort:updated-desc')
  return parts.filter(Boolean).join(' ')
}

export class GitHubApi {
  constructor(private readonly client: GitHubClient) {}

  async fetchViewer(): Promise<string> {
    const data = await this.client.graphql(VIEWER_QUERY, {}, viewerSchema)
    return data.viewer.login
  }

  async fetchLists(
    repo: RepoRef,
    queries: readonly ListQuery[],
  ): Promise<{ viewer: string; categories: PrCategory[] }> {
    if (queries.length === 0) {
      return { viewer: await this.fetchViewer(), categories: [] }
    }

    const variables: Record<string, string> = {}
    queries.forEach((query, index) => {
      variables[`q${index}`] = buildSearchQuery(repo, query.query)
    })

    const data = await this.client.graphql(
      buildListsQuery(queries.length),
      variables,
      listsSchema,
    )

    const categories = queries.map((query, index): PrCategory => {
      const result = parseSearchResult(data[`q${index}`])
      return {
        label: query.label,
        query: query.query,
        totalCount: result?.issueCount ?? 0,
        prs: result ? parsePrSummaries(result.nodes) : [],
      }
    })

    return { viewer: data.viewer.login, categories }
  }

  async fetchBranchPrs(repo: RepoRef, branch: string): Promise<PrSummary[]> {
    const data = await this.client.graphql(
      BRANCH_PRS_QUERY,
      { owner: repo.owner, name: repo.name, branch },
      branchPrsSchema,
    )
    return parsePrSummaries(data.repository?.pullRequests.nodes ?? [])
  }

  async fetchHead(ref: PrRef): Promise<string> {
    const data = await this.client.graphql(
      PR_HEAD_QUERY,
      { owner: ref.owner, name: ref.name, number: ref.number },
      prHeadSchema,
    )
    const head = data.repository?.pullRequest?.headRefOid
    if (!head) throw new GitHubError(`Pull request #${ref.number} was not found`, 'notFound')
    return head
  }

  private async fetchRestFiles(ref: PrRef): Promise<RestFile[]> {
    const files: RestFile[] = []
    for (let page = 1; page <= MAX_REST_FILE_PAGES; page++) {
      const items = await this.client.restJson(
        `/repos/${ref.owner}/${ref.name}/pulls/${ref.number}/files?per_page=100&page=${page}`,
        restFilesSchema,
      )
      files.push(...items)
      if (items.length < 100) break
    }
    return files
  }

  private async fetchMergeBase(ref: PrRef, base: string, head: string): Promise<string> {
    try {
      const data = await this.client.restJson(
        `/repos/${ref.owner}/${ref.name}/compare/${base}...${head}?per_page=1`,
        restCompareSchema,
      )
      return data.merge_base_commit.sha
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'notFound') return base
      throw error
    }
  }

  /**
   * Loads a pull request as a consistent snapshot. The head commit is checked
   * along the way and the load starts again when a push lands in the middle,
   * so the viewed states and the file contents always belong to the same
   * commit.
   */
  async fetchDetail(
    ref: PrRef,
    cache: DiffCache | undefined,
  ): Promise<{ detail: PrDetail; cache: DiffCache }> {
    const variables = { owner: ref.owner, name: ref.name, number: ref.number }

    attempts: for (let attempt = 0; attempt < MAX_DETAIL_ATTEMPTS; attempt++) {
      const data = await this.client.graphql(PR_DETAIL_QUERY, variables, prDetailSchema)
      const repository = data.repository
      const pr = repository?.pullRequest
      if (!repository || !pr) {
        throw new GitHubError(`Pull request #${ref.number} was not found`, 'notFound')
      }

      const head = pr.headRefOid

      const files: RawChangedFile[] = []
      let filesPage = pr.files
      for (;;) {
        for (const file of filesPage?.nodes ?? []) {
          if (file) files.push(file)
        }
        const after = filesPage?.pageInfo.endCursor
        if (!filesPage?.pageInfo.hasNextPage || !after) break

        const next = await this.client.graphql(
          PR_FILES_PAGE_QUERY,
          { ...variables, after },
          prFilesPageSchema,
        )
        const nextPr = next.repository?.pullRequest
        if (!nextPr || nextPr.headRefOid !== head) continue attempts
        filesPage = nextPr.files
      }

      const threads: RawThread[] = []
      let threadsPage = pr.reviewThreads
      for (;;) {
        for (const thread of threadsPage.nodes) {
          if (thread) threads.push(thread)
        }
        const after = threadsPage.pageInfo.endCursor
        if (!threadsPage.pageInfo.hasNextPage || !after) break

        const next = await this.client.graphql(
          PR_THREADS_PAGE_QUERY,
          { ...variables, after },
          prThreadsPageSchema,
        )
        const nextThreads = next.repository?.pullRequest?.reviewThreads
        if (!nextThreads) break
        threadsPage = nextThreads
      }

      const cacheKey = `${head}:${pr.baseRefOid}`
      let diff = cache?.key === cacheKey ? cache : undefined
      if (!diff) {
        const [restFiles, mergeBaseOid] = await Promise.all([
          this.fetchRestFiles(ref),
          this.fetchMergeBase(ref, pr.baseRefOid, head),
        ])
        if ((await this.fetchHead(ref)) !== head) continue
        diff = { key: cacheKey, restFiles, mergeBaseOid }
      }

      const detail: PrDetail = {
        summary: toPrSummary(pr),
        baseRefOid: pr.baseRefOid,
        mergeBaseOid: diff.mergeBaseOid,
        files: toPrFiles(files, diff.restFiles),
        threads: threads.map(toReviewThread),
        pendingReview: toPendingReview(pr),
        overview: toPrOverview(pr, repository),
      }
      return { detail, cache: diff }
    }

    throw new GitHubError(
      `Pull request #${ref.number} kept changing while it was loaded`,
      'api',
    )
  }

  async fetchCommits(ref: PrRef): Promise<PrCommit[]> {
    const data = await this.client.graphql(
      PR_COMMITS_QUERY,
      { owner: ref.owner, name: ref.name, number: ref.number },
      prCommitsSchema,
    )
    const nodes = data.repository?.pullRequest?.commits.nodes ?? []
    return nodes.flatMap((node) =>
      node ?
        [
          {
            oid: node.commit.oid,
            abbreviatedOid: node.commit.abbreviatedOid,
            message: node.commit.messageHeadline,
            committedDate: node.commit.committedDate,
          },
        ]
      : [],
    )
  }

  /** The commits reachable from `head` that changed a file, newest first */
  async fetchCommitsTouchingPath(
    repo: RepoRef,
    head: string,
    path: string,
  ): Promise<string[]> {
    const params = new URLSearchParams({ sha: head, path, per_page: '100' })
    const commits = await this.client.restJson(
      `/repos/${repo.owner}/${repo.name}/commits?${params.toString()}`,
      restCommitsSchema,
    )
    return commits.map((commit) => commit.sha)
  }

  async readBlob(repo: RepoRef, sha: string): Promise<Uint8Array | undefined> {
    return this.client.restBytes(`/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`)
  }

  async readFileAtCommit(
    repo: RepoRef,
    commit: string,
    path: string,
  ): Promise<Uint8Array | undefined> {
    return this.client.restBytes(
      `/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}?ref=${commit}`,
    )
  }

  /**
   * Marks or unmarks files as viewed. Returns the head commit of the pull
   * request after the change, which tells if the files were marked on the
   * version that the user was looking at.
   */
  async setFilesViewed(
    pullRequestId: string,
    paths: readonly string[],
    viewed: boolean,
  ): Promise<string | undefined> {
    let head: string | undefined

    for (const batch of chunk(paths, 40)) {
      const variables: Record<string, string> = { pr: pullRequestId }
      batch.forEach((path, index) => {
        variables[`p${index}`] = path
      })
      const data = await this.client.graphql(
        buildSetViewedMutation(batch.length, viewed),
        variables,
        setViewedSchema,
      )
      for (const result of Object.values(data)) {
        head = result?.pullRequest?.headRefOid ?? head
      }
    }

    return head
  }

  async addThread(input: {
    pullRequestId: string
    pullRequestReviewId: string | undefined
    path: string
    body: string
    line: number | undefined
    startLine: number | undefined
    side: DiffSide
  }): Promise<CommentResult | undefined> {
    const isFileLevel = input.line === undefined
    const data = await this.client.graphql(
      ADD_THREAD_MUTATION,
      {
        input: {
          pullRequestId: input.pullRequestId,
          pullRequestReviewId: input.pullRequestReviewId,
          path: input.path,
          body: input.body,
          ...(isFileLevel ?
            { subjectType: 'FILE' }
          : {
              line: input.line,
              side: input.side,
              ...(input.startLine !== undefined && input.startLine !== input.line ?
                { startLine: input.startLine, startSide: input.side }
              : {}),
            }),
        },
      },
      addThreadSchema,
    )
    const thread = data.addPullRequestReviewThread?.thread
    if (!thread) {
      throw new GitHubError('GitHub did not create the comment', 'api')
    }
    return thread.comments.nodes[0] ?? undefined
  }

  async addThreadReply(input: {
    threadId: string
    pullRequestReviewId: string | undefined
    body: string
  }): Promise<CommentResult | undefined> {
    const data = await this.client.graphql(
      ADD_THREAD_REPLY_MUTATION,
      {
        input: {
          pullRequestReviewThreadId: input.threadId,
          pullRequestReviewId: input.pullRequestReviewId,
          body: input.body,
        },
      },
      addThreadReplySchema,
    )
    const comment = data.addPullRequestReviewThreadReply?.comment
    if (!comment) throw new GitHubError('GitHub did not create the reply', 'api')
    return comment
  }

  /** Creates a review. Without an event the review stays pending */
  async addReview(input: {
    pullRequestId: string
    event: ReviewEvent | undefined
    body: string | undefined
  }): Promise<string | undefined> {
    const data = await this.client.graphql(
      ADD_REVIEW_MUTATION,
      {
        input: {
          pullRequestId: input.pullRequestId,
          event: input.event,
          body: input.body,
        },
      },
      addReviewSchema,
    )
    return data.addPullRequestReview?.pullRequestReview?.id
  }

  async submitReview(input: {
    pullRequestReviewId: string
    event: ReviewEvent
    body: string | undefined
  }): Promise<void> {
    await this.client.graphql(SUBMIT_REVIEW_MUTATION, { input }, anyMutationSchema)
  }

  async deleteReview(pullRequestReviewId: string): Promise<void> {
    await this.client.graphql(
      DELETE_REVIEW_MUTATION,
      { input: { pullRequestReviewId } },
      anyMutationSchema,
    )
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    await this.client.graphql(
      UPDATE_COMMENT_MUTATION,
      { input: { pullRequestReviewCommentId: commentId, body } },
      anyMutationSchema,
    )
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.client.graphql(
      DELETE_COMMENT_MUTATION,
      { input: { id: commentId } },
      anyMutationSchema,
    )
  }

  async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    await this.client.graphql(
      resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION,
      { input: { threadId } },
      anyMutationSchema,
    )
  }

  async addIssueComment(pullRequestId: string, body: string): Promise<void> {
    await this.client.graphql(
      ADD_ISSUE_COMMENT_MUTATION,
      { input: { subjectId: pullRequestId, body } },
      anyMutationSchema,
    )
  }

  async merge(input: {
    pullRequestId: string
    mergeMethod: MergeMethod
    /** The merge fails when the pull request has other commits than these */
    expectedHeadOid: string
  }): Promise<void> {
    await this.client.graphql(MERGE_MUTATION, { input }, anyMutationSchema)
  }

  /** GitHub merges the pull request on its own when its requirements are met */
  async enableAutoMerge(input: {
    pullRequestId: string
    mergeMethod: MergeMethod
    /** Fails when the pull request has other commits than these */
    expectedHeadOid: string
  }): Promise<void> {
    await this.client.graphql(ENABLE_AUTO_MERGE_MUTATION, { input }, anyMutationSchema)
  }

  async disableAutoMerge(pullRequestId: string): Promise<void> {
    await this.client.graphql(
      DISABLE_AUTO_MERGE_MUTATION,
      { input: { pullRequestId } },
      anyMutationSchema,
    )
  }

  async markReadyForReview(pullRequestId: string): Promise<void> {
    await this.client.graphql(
      READY_FOR_REVIEW_MUTATION,
      { input: { pullRequestId } },
      anyMutationSchema,
    )
  }
}
