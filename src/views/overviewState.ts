import type { PrDetail } from '../model/types'
import type { OverviewState } from '../shared/overviewProtocol'

/** Builds what the overview page of a pull request shows */
export function buildOverviewState(args: {
  prKey: string
  detail: PrDetail
  isCheckedOut: boolean
  canCheckout: boolean
  refreshError: string | undefined
}): OverviewState {
  const { detail } = args
  const { summary, overview } = detail

  return {
    prKey: args.prKey,
    number: summary.number,
    title: summary.title,
    url: summary.url,
    state: summary.state,
    isDraft: summary.isDraft,
    author: summary.author,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    createdAt: overview.createdAt,
    bodyHtml: overview.bodyHtml,
    additions: overview.additions,
    deletions: overview.deletions,
    fileCount: detail.files.length,
    viewedCount: detail.files.filter((file) => file.viewedState === 'VIEWED').length,
    mergedBy: overview.mergedBy,
    labels: overview.labels,
    assignees: overview.assignees,
    milestone: overview.milestone,
    reviewers: overview.reviewers,
    reviewDecision: summary.reviewDecision,
    checkState: summary.checkState,
    checks: overview.checks,
    timeline: overview.timeline,
    threads: detail.threads.map((thread) => ({
      id: thread.id,
      path: thread.path,
      line: thread.line,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        author: comment.author,
        bodyHtml: comment.bodyHtml,
        createdAt: comment.createdAt,
        isPending: comment.isPending,
      })),
    })),
    mergeable: overview.mergeable,
    mergeStateStatus: overview.mergeStateStatus,
    mergeMethods: overview.allowedMergeMethods,
    defaultMergeMethod: overview.defaultMergeMethod,
    viewerCanUpdate: overview.viewerCanUpdate,
    viewerDidAuthor: overview.viewerDidAuthor,
    pendingReviewComments: detail.pendingReview?.commentCount,
    isCheckedOut: args.isCheckedOut,
    canCheckout: args.canCheckout,
    refreshError: args.refreshError,
  }
}
