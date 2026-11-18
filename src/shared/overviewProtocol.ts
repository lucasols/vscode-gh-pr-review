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

/** Something that a button of the side bar adds to the pull request with one click */
const quickAddOptionSchema = z.object({
  /** What the page sends back when its button is clicked */
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** The color of a label, as six hex digits */
  color: z.string().optional(),
  avatarUrl: z.string().optional(),
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
  /** Why the viewer cannot merge now. Not set when they can */
  mergeBlock: z
    .object({
      kind: z.enum([
        'closed',
        'draft',
        'permission',
        'noMethod',
        'conflicts',
        'checking',
        'rules',
      ]),
      reason: z.string(),
      canBypass: z.boolean(),
    })
    .optional(),
  /** Set while GitHub waits for the requirements to merge on its own */
  autoMerge: z
    .object({ mergeMethod: mergeMethodSchema, enabledBy: z.string().optional() })
    .optional(),
  canEnableAutoMerge: z.boolean(),
  canDisableAutoMerge: z.boolean(),
  viewerCanUpdate: z.boolean(),
  canEditLabels: z.boolean(),
  canEditReviewers: z.boolean(),
  /** Who the user picked for the repository and is not a reviewer yet */
  quickAddReviewers: z.array(quickAddOptionSchema),
  /** The labels that the user picked for the repository and the pull request lacks */
  quickAddLabels: z.array(quickAddOptionSchema),
  viewerDidAuthor: z.boolean(),
  pendingReviewComments: z.number().optional(),
  isCheckedOut: z.boolean(),
  canCheckout: z.boolean(),
  refreshError: z.string().optional(),
})

export type OverviewState = z.infer<typeof overviewStateSchema>
export type OverviewTimelineItem = z.infer<typeof timelineItemSchema>
export type OverviewThread = z.infer<typeof threadSchema>

/** The sections of the side bar that are edited in a dropdown of the page */
const editFieldSchema = z.enum(['reviewers', 'labels'])

const editOptionSchema = z.object({
  /** What the page sends back for an option that is checked */
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /** The color of a label, as six hex digits */
  color: z.string().optional(),
  avatarUrl: z.string().optional(),
  checked: z.boolean(),
})

export type OverviewEditField = z.infer<typeof editFieldSchema>
export type OverviewQuickAddOption = z.infer<typeof quickAddOptionSchema>
export type OverviewEditOption = z.infer<typeof editOptionSchema>

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
  /** The answer to `loadEditOptions`: the options, or why they could not be loaded */
  z.object({
    type: z.literal('editOptions'),
    field: editFieldSchema,
    options: z.array(editOptionSchema).optional(),
    error: z.string().optional(),
  }),
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
  z.object({ type: z.literal('enableAutoMerge'), method: mergeMethodSchema }),
  z.object({ type: z.literal('disableAutoMerge') }),
  z.object({ type: z.literal('readyForReview') }),
  /** The dropdown of a section opened and needs its options */
  z.object({ type: z.literal('loadEditOptions'), field: editFieldSchema }),
  /** The dropdown closed with these options checked */
  z.object({
    type: z.literal('applyEdit'),
    field: editFieldSchema,
    checked: z.array(z.string()),
  }),
  /** Buttons of quick add were clicked: these reviewers or labels are added */
  z.object({
    type: z.literal('quickAdd'),
    field: editFieldSchema,
    keys: z.array(z.string()),
  }),
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
