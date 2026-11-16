import { z } from 'zod'
import type {
  Actor,
  CheckRun,
  CheckState,
  FileStatus,
  MergeMethod,
  PrFile,
  PrOverview,
  PrSummary,
  ReviewThread,
  Reviewer,
  TimelineItem,
} from '../model/types'

/** Schemas of the GitHub responses and their conversion to the model */

const actorSchema = z
  .object({ login: z.string(), avatarUrl: z.string().optional() })
  .nullable()

function toActor(actor: z.infer<typeof actorSchema> | undefined): Actor | undefined {
  if (!actor) return undefined
  return { login: actor.login, avatarUrl: actor.avatarUrl }
}

function toCheckState(state: string | null | undefined): CheckState {
  switch (state) {
    case 'SUCCESS':
      return 'SUCCESS'
    case 'FAILURE':
    case 'ERROR':
      return 'FAILURE'
    case 'PENDING':
    case 'EXPECTED':
      return 'PENDING'
    default:
      return 'NONE'
  }
}

const prSummarySchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  updatedAt: z.string(),
  author: actorSchema,
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  isCrossRepository: z.boolean(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  repository: z.object({ nameWithOwner: z.string() }),
  lastCommit: z.object({
    nodes: z.array(
      z
        .object({
          commit: z.object({
            statusCheckRollup: z.object({ state: z.string() }).nullable(),
          }),
        })
        .nullable(),
    ),
  }),
})

type RawPrSummary = z.infer<typeof prSummarySchema>

export function toPrSummary(raw: RawPrSummary): PrSummary {
  return {
    id: raw.id,
    repo: raw.repository.nameWithOwner,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft,
    updatedAt: raw.updatedAt,
    author: toActor(raw.author),
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headRefOid: raw.headRefOid,
    headRepoOwner: raw.headRepositoryOwner?.login,
    isCrossRepository: raw.isCrossRepository,
    reviewDecision: raw.reviewDecision ?? undefined,
    checkState: toCheckState(raw.lastCommit.nodes[0]?.commit.statusCheckRollup?.state),
  }
}

/** Search results can contain empty objects for nodes that are not pull requests */
export function parsePrSummaries(nodes: readonly unknown[]): PrSummary[] {
  const result: PrSummary[] = []
  for (const node of nodes) {
    const parsed = prSummarySchema.safeParse(node)
    if (parsed.success) result.push(toPrSummary(parsed.data))
  }
  return result
}

export const viewerSchema = z.object({ viewer: z.object({ login: z.string() }) })

const searchResultSchema = z.object({
  issueCount: z.number(),
  nodes: z.array(z.unknown()),
})

export const listsSchema = z
  .object({ viewer: z.object({ login: z.string() }) })
  .catchall(searchResultSchema)

export function parseSearchResult(
  value: unknown,
): z.infer<typeof searchResultSchema> | undefined {
  const parsed = searchResultSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export const branchPrsSchema = z.object({
  repository: z
    .object({ pullRequests: z.object({ nodes: z.array(z.unknown()) }) })
    .nullable(),
})

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
})

const changedFileSchema = z.object({
  path: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changeType: z.string(),
  viewerViewedState: z.enum(['VIEWED', 'UNVIEWED', 'DISMISSED']),
})

export type RawChangedFile = z.infer<typeof changedFileSchema>

const filesConnectionSchema = z
  .object({
    pageInfo: pageInfoSchema,
    nodes: z.array(changedFileSchema.nullable()),
  })
  .nullable()

const threadSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  startLine: z.number().nullable(),
  diffSide: z.enum(['LEFT', 'RIGHT']),
  subjectType: z.string().nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  viewerCanReply: z.boolean(),
  comments: z.object({
    nodes: z.array(
      z
        .object({
          id: z.string(),
          body: z.string(),
          bodyHTML: z.string(),
          createdAt: z.string(),
          url: z.string(),
          state: z.string(),
          author: actorSchema,
          viewerCanUpdate: z.boolean(),
          viewerCanDelete: z.boolean(),
        })
        .nullable(),
    ),
  }),
})

export type RawThread = z.infer<typeof threadSchema>

const threadsConnectionSchema = z.object({
  pageInfo: pageInfoSchema,
  nodes: z.array(threadSchema.nullable()),
})

export function toReviewThread(raw: RawThread): ReviewThread {
  return {
    id: raw.id,
    path: raw.path,
    line: raw.line ?? undefined,
    startLine: raw.startLine ?? undefined,
    side: raw.diffSide,
    isResolved: raw.isResolved,
    isOutdated: raw.isOutdated,
    isFileLevel: raw.subjectType === 'FILE',
    canResolve: raw.viewerCanResolve,
    canUnresolve: raw.viewerCanUnresolve,
    canReply: raw.viewerCanReply,
    comments: raw.comments.nodes.flatMap((comment) =>
      comment ?
        [
          {
            id: comment.id,
            body: comment.body,
            bodyHtml: comment.bodyHTML,
            createdAt: comment.createdAt,
            url: comment.url,
            author: toActor(comment.author),
            isPending: comment.state === 'PENDING',
            canEdit: comment.viewerCanUpdate,
            canDelete: comment.viewerCanDelete,
          },
        ]
      : [],
    ),
  }
}

const requestedReviewerSchema = z
  .object({
    __typename: z.string(),
    login: z.string().optional(),
    name: z.string().optional(),
    avatarUrl: z.string().optional(),
    teamAvatarUrl: z.string().nullable().optional(),
  })
  .nullable()

const checkContextSchema = z.object({
  __typename: z.string(),
  name: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  status: z.string().optional(),
  detailsUrl: z.string().nullable().optional(),
  context: z.string().optional(),
  state: z.string().optional(),
  targetUrl: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
})

const timelineNodeSchema = z.object({
  __typename: z.string(),
  id: z.string().optional(),
  bodyHTML: z.string().optional(),
  createdAt: z.string().optional(),
  submittedAt: z.string().nullable().optional(),
  url: z.string().optional(),
  state: z.string().optional(),
  author: actorSchema.optional(),
  actor: actorSchema.optional(),
  comments: z.object({ totalCount: z.number() }).optional(),
  mergeRefName: z.string().optional(),
  beforeCommit: z.object({ abbreviatedOid: z.string() }).nullable().optional(),
  afterCommit: z.object({ abbreviatedOid: z.string() }).nullable().optional(),
})

type RawTimelineNode = z.infer<typeof timelineNodeSchema>

const prDetailNodeSchema = prSummarySchema.extend({
  bodyHTML: z.string(),
  baseRefOid: z.string(),
  createdAt: z.string(),
  additions: z.number(),
  deletions: z.number(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeStateStatus: z.string(),
  viewerCanUpdate: z.boolean(),
  viewerDidAuthor: z.boolean(),
  mergedBy: z.object({ login: z.string() }).nullable(),
  labels: z
    .object({
      nodes: z.array(z.object({ name: z.string(), color: z.string() }).nullable()),
    })
    .nullable(),
  assignees: z.object({ nodes: z.array(actorSchema) }),
  milestone: z.object({ title: z.string() }).nullable(),
  reviewRequests: z
    .object({
      nodes: z.array(
        z.object({ requestedReviewer: requestedReviewerSchema }).nullable(),
      ),
    })
    .nullable(),
  latestOpinionatedReviews: z
    .object({
      nodes: z.array(z.object({ state: z.string(), author: actorSchema }).nullable()),
    })
    .nullable(),
  pendingReviews: z
    .object({
      nodes: z.array(
        z
          .object({
            id: z.string(),
            viewerDidAuthor: z.boolean(),
            comments: z.object({ totalCount: z.number() }),
          })
          .nullable(),
      ),
    })
    .nullable(),
  checks: z.object({
    nodes: z.array(
      z
        .object({
          commit: z.object({
            statusCheckRollup: z
              .object({
                contexts: z.object({ nodes: z.array(checkContextSchema.nullable()) }),
              })
              .nullable(),
          }),
        })
        .nullable(),
    ),
  }),
  reviewThreads: threadsConnectionSchema,
  files: filesConnectionSchema,
  timelineItems: z.object({ nodes: z.array(timelineNodeSchema.nullable()) }),
})

export type RawPrDetail = z.infer<typeof prDetailNodeSchema>

export const prDetailSchema = z.object({
  repository: z
    .object({
      mergeCommitAllowed: z.boolean(),
      squashMergeAllowed: z.boolean(),
      rebaseMergeAllowed: z.boolean(),
      viewerDefaultMergeMethod: z.string(),
      pullRequest: prDetailNodeSchema.nullable(),
    })
    .nullable(),
})

export type RawRepoSettings = Pick<
  NonNullable<z.infer<typeof prDetailSchema>['repository']>,
  | 'mergeCommitAllowed'
  | 'squashMergeAllowed'
  | 'rebaseMergeAllowed'
  | 'viewerDefaultMergeMethod'
>

export const prFilesPageSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({ headRefOid: z.string(), files: filesConnectionSchema })
        .nullable(),
    })
    .nullable(),
})

export const prThreadsPageSchema = z.object({
  repository: z
    .object({
      pullRequest: z.object({ reviewThreads: threadsConnectionSchema }).nullable(),
    })
    .nullable(),
})

export const prHeadSchema = z.object({
  repository: z
    .object({ pullRequest: z.object({ headRefOid: z.string() }).nullable() })
    .nullable(),
})

export const prCommitsSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          commits: z.object({
            nodes: z.array(
              z
                .object({
                  commit: z.object({
                    oid: z.string(),
                    abbreviatedOid: z.string(),
                    messageHeadline: z.string(),
                    committedDate: z.string(),
                  }),
                })
                .nullable(),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
})

export const setViewedSchema = z.record(
  z.string(),
  z
    .object({ pullRequest: z.object({ headRefOid: z.string() }).nullable() })
    .nullable(),
)

const commentResultSchema = z.object({
  id: z.string(),
  state: z.string(),
  pullRequestReview: z.object({ id: z.string(), state: z.string() }).nullable(),
})

export type CommentResult = z.infer<typeof commentResultSchema>

export const addThreadSchema = z.object({
  addPullRequestReviewThread: z
    .object({
      thread: z
        .object({
          id: z.string(),
          comments: z.object({ nodes: z.array(commentResultSchema.nullable()) }),
        })
        .nullable(),
    })
    .nullable(),
})

export const addThreadReplySchema = z.object({
  addPullRequestReviewThreadReply: z
    .object({ comment: commentResultSchema.nullable() })
    .nullable(),
})

export const addReviewSchema = z.object({
  addPullRequestReview: z
    .object({
      pullRequestReview: z.object({ id: z.string(), state: z.string() }).nullable(),
    })
    .nullable(),
})

export const anyMutationSchema = z.record(z.string(), z.unknown())

export const restFileSchema = z.object({
  sha: z.string().nullable(),
  filename: z.string(),
  status: z.string(),
  previous_filename: z.string().optional(),
  patch: z.string().optional(),
})

export type RestFile = z.infer<typeof restFileSchema>

export const restFilesSchema = z.array(restFileSchema)

export const restCompareSchema = z.object({
  merge_base_commit: z.object({ sha: z.string() }),
})

export const restCommitsSchema = z.array(z.object({ sha: z.string() }))

function statusFromRest(status: string): FileStatus | undefined {
  switch (status) {
    case 'added':
    case 'removed':
    case 'modified':
    case 'renamed':
    case 'copied':
      return status
    case 'changed':
    case 'unchanged':
      return 'modified'
    default:
      return undefined
  }
}

function statusFromChangeType(changeType: string): FileStatus {
  switch (changeType) {
    case 'ADDED':
      return 'added'
    case 'DELETED':
      return 'removed'
    case 'RENAMED':
      return 'renamed'
    case 'COPIED':
      return 'copied'
    default:
      return 'modified'
  }
}

/**
 * Joins the two lists of files that GitHub has: GraphQL knows the viewed
 * state, REST knows the blob, the patch and the previous path.
 */
export function toPrFiles(
  graphqlFiles: readonly RawChangedFile[],
  restFiles: readonly RestFile[],
): PrFile[] {
  const restByPath = new Map(restFiles.map((file) => [file.filename, file]))

  return graphqlFiles.map((file): PrFile => {
    const rest = restByPath.get(file.path)
    const status =
      (rest && statusFromRest(rest.status)) ?? statusFromChangeType(file.changeType)

    return {
      path: file.path,
      previousPath: rest?.previous_filename,
      status,
      additions: file.additions,
      deletions: file.deletions,
      viewedState: file.viewerViewedState,
      blobSha: status === 'removed' ? undefined : (rest?.sha ?? undefined),
      patch: rest?.patch,
    }
  })
}

function toCheckRuns(raw: RawPrDetail): CheckRun[] {
  const contexts = raw.checks.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
  const result: CheckRun[] = []

  for (const context of contexts) {
    if (!context) continue

    if (context.__typename === 'CheckRun') {
      let state: CheckState = 'PENDING'
      if (context.status === 'COMPLETED') {
        const passed =
          context.conclusion === 'SUCCESS' ||
          context.conclusion === 'NEUTRAL' ||
          context.conclusion === 'SKIPPED'
        state = passed ? 'SUCCESS' : 'FAILURE'
      }
      result.push({
        name: context.name ?? 'Check',
        state,
        url: context.detailsUrl ?? undefined,
        description:
          context.status === 'COMPLETED' ?
            (context.conclusion?.toLowerCase().replaceAll('_', ' ') ?? undefined)
          : context.status?.toLowerCase().replaceAll('_', ' '),
      })
    } else if (context.__typename === 'StatusContext') {
      result.push({
        name: context.context ?? 'Status',
        state: toCheckState(context.state),
        url: context.targetUrl ?? undefined,
        description: context.description ?? undefined,
      })
    }
  }

  return result
}

function toReviewerState(state: string): Reviewer['state'] | undefined {
  switch (state) {
    case 'APPROVED':
    case 'CHANGES_REQUESTED':
    case 'COMMENTED':
    case 'DISMISSED':
      return state
    default:
      return undefined
  }
}

function toReviewers(raw: RawPrDetail): Reviewer[] {
  const reviewers = new Map<string, Reviewer>()

  for (const review of raw.latestOpinionatedReviews?.nodes ?? []) {
    const state = review && toReviewerState(review.state)
    if (!review?.author || !state) continue
    reviewers.set(review.author.login, {
      name: review.author.login,
      avatarUrl: review.author.avatarUrl,
      state,
    })
  }

  // a new request for a reviewer replaces the review that they gave before
  for (const request of raw.reviewRequests?.nodes ?? []) {
    const reviewer = request?.requestedReviewer
    const name = reviewer?.login ?? reviewer?.name
    if (!reviewer || !name) continue
    reviewers.set(name, {
      name,
      avatarUrl: reviewer.avatarUrl ?? reviewer.teamAvatarUrl ?? undefined,
      state: 'REQUESTED',
    })
  }

  return [...reviewers.values()]
}

function toTimelineReviewState(
  state: string | undefined,
): Extract<TimelineItem, { type: 'review' }>['state'] {
  switch (state) {
    case 'APPROVED':
    case 'CHANGES_REQUESTED':
    case 'DISMISSED':
    case 'PENDING':
      return state
    default:
      return 'COMMENTED'
  }
}

function toTimelineItem(node: RawTimelineNode, index: number): TimelineItem | undefined {
  const id = node.id ?? `${node.__typename}-${index}`

  switch (node.__typename) {
    case 'IssueComment':
      return {
        type: 'comment',
        id,
        author: toActor(node.author),
        createdAt: node.createdAt ?? '',
        bodyHtml: node.bodyHTML ?? '',
        url: node.url ?? '',
      }
    case 'PullRequestReview': {
      const state = toTimelineReviewState(node.state)
      const commentCount = node.comments?.totalCount ?? 0
      // a review that only carries inline comments adds nothing to the timeline
      if (state === 'COMMENTED' && !node.bodyHTML && commentCount === 0) return undefined
      return {
        type: 'review',
        id,
        author: toActor(node.author),
        createdAt: node.submittedAt ?? node.createdAt ?? '',
        bodyHtml: node.bodyHTML ?? '',
        url: node.url ?? '',
        state,
        commentCount,
      }
    }
    case 'HeadRefForcePushedEvent':
      return {
        type: 'event',
        id,
        author: toActor(node.actor),
        createdAt: node.createdAt ?? '',
        event: 'forcePushed',
        detail:
          node.beforeCommit && node.afterCommit ?
            `${node.beforeCommit.abbreviatedOid} → ${node.afterCommit.abbreviatedOid}`
          : undefined,
      }
    case 'MergedEvent':
      return {
        type: 'event',
        id,
        author: toActor(node.actor),
        createdAt: node.createdAt ?? '',
        event: 'merged',
        detail: node.mergeRefName,
      }
    case 'ClosedEvent':
      return {
        type: 'event',
        id,
        author: toActor(node.actor),
        createdAt: node.createdAt ?? '',
        event: 'closed',
        detail: undefined,
      }
    case 'ReopenedEvent':
      return {
        type: 'event',
        id,
        author: toActor(node.actor),
        createdAt: node.createdAt ?? '',
        event: 'reopened',
        detail: undefined,
      }
    default:
      return undefined
  }
}

function toMergeMethod(value: string): MergeMethod | undefined {
  switch (value) {
    case 'MERGE':
    case 'SQUASH':
    case 'REBASE':
      return value
    default:
      return undefined
  }
}

export function toPrOverview(raw: RawPrDetail, repo: RawRepoSettings): PrOverview {
  const allowedMergeMethods: MergeMethod[] = []
  if (repo.mergeCommitAllowed) allowedMergeMethods.push('MERGE')
  if (repo.squashMergeAllowed) allowedMergeMethods.push('SQUASH')
  if (repo.rebaseMergeAllowed) allowedMergeMethods.push('REBASE')

  const preferred = toMergeMethod(repo.viewerDefaultMergeMethod)
  const defaultMergeMethod =
    preferred && allowedMergeMethods.includes(preferred) ?
      preferred
    : (allowedMergeMethods[0] ?? 'MERGE')

  return {
    bodyHtml: raw.bodyHTML,
    createdAt: raw.createdAt,
    additions: raw.additions,
    deletions: raw.deletions,
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    viewerCanUpdate: raw.viewerCanUpdate,
    viewerDidAuthor: raw.viewerDidAuthor,
    mergedBy: raw.mergedBy?.login,
    labels: (raw.labels?.nodes ?? []).flatMap((label) => (label ? [label] : [])),
    assignees: raw.assignees.nodes.flatMap((assignee) => {
      const actor = toActor(assignee)
      return actor ? [actor] : []
    }),
    milestone: raw.milestone?.title,
    reviewers: toReviewers(raw),
    checks: toCheckRuns(raw),
    timeline: raw.timelineItems.nodes.flatMap((node, index) => {
      const item = node && toTimelineItem(node, index)
      return item ? [item] : []
    }),
    allowedMergeMethods,
    defaultMergeMethod,
  }
}

export function toPendingReview(
  raw: RawPrDetail,
): { id: string; commentCount: number } | undefined {
  for (const review of raw.pendingReviews?.nodes ?? []) {
    if (review?.viewerDidAuthor) {
      return { id: review.id, commentCount: review.comments.totalCount }
    }
  }
  return undefined
}
