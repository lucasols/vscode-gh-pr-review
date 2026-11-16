import { z } from 'zod'

/**
 * The messages between the extension and the overview page of a pull
 * request. Both sides parse what they receive with these schemas.
 */

const actorSchema = z.object({ login: z.string(), avatarUrl: z.string().optional() })

const checkStateSchema = z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'NONE'])
const mergeMethodSchema = z.enum(['MERGE', 'SQUASH', 'REBASE'])
const reviewEventSchema = z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES'])

const timelineItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('comment'),
    id: z.string(),
    author: actorSchema.optional(),
    createdAt: z.string(),
    bodyHtml: z.string(),
    url: z.string(),
  }),
  z.object({
    type: z.literal('review'),
    id: z.string(),
    author: actorSchema.optional(),
    createdAt: z.string(),
    bodyHtml: z.string(),
    url: z.string(),
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
    commentCount: z.number(),
  }),
  z.object({
    type: z.literal('commit'),
    id: z.string(),
    author: actorSchema.optional(),
    authorName: z.string().optional(),
    createdAt: z.string(),
    message: z.string(),
    abbreviatedOid: z.string(),
    url: z.string(),
  }),
  z.object({
    type: z.literal('event'),
    id: z.string(),
    author: actorSchema.optional(),
    createdAt: z.string(),
    event: z.enum(['merged', 'closed', 'reopened', 'forcePushed']),
    detail: z.string().optional(),
  }),
])

const threadSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().optional(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.array(
    z.object({
      id: z.string(),
      author: actorSchema.optional(),
      bodyHtml: z.string(),
      createdAt: z.string(),
      isPending: z.boolean(),
    }),
  ),
})

export const overviewStateSchema = z.object({
  prKey: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  author: actorSchema.optional(),
  baseRefName: z.string(),
  headRefName: z.string(),
  createdAt: z.string(),
  bodyHtml: z.string(),
  additions: z.number(),
  deletions: z.number(),
  fileCount: z.number(),
  viewedCount: z.number(),
  mergedBy: z.string().optional(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  assignees: z.array(actorSchema),
  milestone: z.string().optional(),
  reviewers: z.array(
    z.object({
      name: z.string(),
      avatarUrl: z.string().optional(),
      state: z.enum(['REQUESTED', 'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']),
    }),
  ),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).optional(),
  checkState: checkStateSchema,
  checks: z.array(
    z.object({
      name: z.string(),
      state: checkStateSchema,
      url: z.string().optional(),
      description: z.string().optional(),
    }),
  ),
  timeline: z.array(timelineItemSchema),
  threads: z.array(threadSchema),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeStateStatus: z.string(),
  mergeMethods: z.array(mergeMethodSchema),
  defaultMergeMethod: mergeMethodSchema,
  viewerCanUpdate: z.boolean(),
  viewerDidAuthor: z.boolean(),
  pendingReviewComments: z.number().optional(),
  isCheckedOut: z.boolean(),
  canCheckout: z.boolean(),
  refreshError: z.string().optional(),
})

export type OverviewState = z.infer<typeof overviewStateSchema>
export type OverviewTimelineItem = z.infer<typeof timelineItemSchema>
export type OverviewThread = z.infer<typeof threadSchema>

export const toWebviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), state: overviewStateSchema }),
  z.object({
    type: z.literal('loading'),
    prKey: z.string(),
    error: z.string().optional(),
  }),
  /** The name of the action that is running, so its button can show it */
  z.object({ type: z.literal('busy'), action: z.string().optional() }),
  /** The action finished, so the text that was sent can be cleared */
  z.object({ type: z.literal('done'), action: z.string() }),
])

export type ToWebviewMessage = z.infer<typeof toWebviewMessageSchema>

export const fromWebviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('checkout') }),
  z.object({ type: z.literal('reviewChanges') }),
  z.object({ type: z.literal('openOnGitHub') }),
  z.object({ type: z.literal('copyLink') }),
  z.object({ type: z.literal('merge'), method: mergeMethodSchema }),
  z.object({ type: z.literal('readyForReview') }),
  z.object({ type: z.literal('comment'), body: z.string() }),
  z.object({ type: z.literal('review'), event: reviewEventSchema, body: z.string() }),
  z.object({
    type: z.literal('openFile'),
    path: z.string(),
  }),
])

export type FromWebviewMessage = z.infer<typeof fromWebviewMessageSchema>

/** What the page keeps so that VS Code can restore it after a restart */
export const overviewPersistedSchema = z.object({ prKey: z.string() })
