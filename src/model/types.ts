import { parseRepoKey, repoKey, type RepoRef } from '../util/remoteUrl'

export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED'
export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied'
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'
export type CheckState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE'
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
export type DiffSide = 'LEFT' | 'RIGHT'
export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE'
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'

export type PrRef = RepoRef & { number: number }

export function prKey(ref: PrRef): string {
  return `${repoKey(ref)}#${ref.number}`
}

export function parsePrKey(key: string): PrRef | undefined {
  const index = key.lastIndexOf('#')
  if (index === -1) return undefined
  const repo = parseRepoKey(key.slice(0, index))
  const number = Number(key.slice(index + 1))
  if (!repo || !Number.isInteger(number) || number <= 0) return undefined
  return { ...repo, number }
}

export type Actor = { login: string; avatarUrl: string | undefined }

export type PrSummary = {
  /** GraphQL node id */
  id: string
  /** `owner/name` of the repository that the pull request targets */
  repo: string
  number: number
  title: string
  url: string
  state: PrState
  isDraft: boolean
  updatedAt: string
  author: Actor | undefined
  baseRefName: string
  headRefName: string
  headRefOid: string
  headRepoOwner: string | undefined
  isCrossRepository: boolean
  reviewDecision: ReviewDecision | undefined
  checkState: CheckState
}

export function summaryKey(pr: PrSummary): string {
  return `${pr.repo}#${pr.number}`
}

export type PrFile = {
  path: string
  /** The path in the base version, when the file was renamed or copied */
  previousPath: string | undefined
  status: FileStatus
  additions: number
  deletions: number
  viewedState: ViewedState
  /** The git blob of the head version. Unknown for removed files */
  blobSha: string | undefined
  /** The unified diff of the file. Missing for binary or very large files */
  patch: string | undefined
}

export type ReviewComment = {
  id: string
  body: string
  bodyHtml: string
  createdAt: string
  url: string
  author: Actor | undefined
  /** Part of a review that was not submitted yet, only its author sees it */
  isPending: boolean
  canEdit: boolean
  canDelete: boolean
}

export type ReviewThread = {
  id: string
  path: string
  /** 1-based line in the current diff. Undefined when outdated or file level */
  line: number | undefined
  startLine: number | undefined
  side: DiffSide
  isResolved: boolean
  isOutdated: boolean
  isFileLevel: boolean
  canResolve: boolean
  canUnresolve: boolean
  canReply: boolean
  comments: ReviewComment[]
}

export type CheckRun = {
  name: string
  state: CheckState
  url: string | undefined
  description: string | undefined
}

export type Reviewer = {
  name: string
  avatarUrl: string | undefined
  state: 'REQUESTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'
}

export type TimelineItem =
  | {
      type: 'comment'
      id: string
      author: Actor | undefined
      createdAt: string
      bodyHtml: string
      url: string
    }
  | {
      type: 'review'
      id: string
      author: Actor | undefined
      createdAt: string
      bodyHtml: string
      url: string
      state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
      commentCount: number
    }
  | {
      type: 'commit'
      id: string
      author: Actor | undefined
      authorName: string | undefined
      createdAt: string
      message: string
      abbreviatedOid: string
      url: string
    }
  | {
      type: 'event'
      id: string
      author: Actor | undefined
      createdAt: string
      event: 'merged' | 'closed' | 'reopened' | 'forcePushed'
      detail: string | undefined
    }

export type PrOverview = {
  bodyHtml: string
  createdAt: string
  additions: number
  deletions: number
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  viewerCanUpdate: boolean
  viewerDidAuthor: boolean
  mergedBy: string | undefined
  labels: { name: string; color: string }[]
  assignees: Actor[]
  milestone: string | undefined
  reviewers: Reviewer[]
  checks: CheckRun[]
  timeline: TimelineItem[]
  allowedMergeMethods: MergeMethod[]
  defaultMergeMethod: MergeMethod
}

export type PrDetail = {
  summary: PrSummary
  baseRefOid: string
  /** The commit that the diff of the pull request starts from */
  mergeBaseOid: string
  files: PrFile[]
  threads: ReviewThread[]
  pendingReview: { id: string; commentCount: number } | undefined
  overview: PrOverview
}

/**
 * Identifies the content of the head version of a file. Removed files have no
 * blob, so they get a fixed marker.
 */
export function headBlobId(
  file: Pick<PrFile, 'status' | 'blobSha'>,
): string | undefined {
  return file.status === 'removed' ? REMOVED_BLOB : file.blobSha
}

export const REMOVED_BLOB = 'removed'
