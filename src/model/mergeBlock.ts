import type { PrOverview, PrSummary } from './types'

export type MergeBlock = {
  kind: 'closed' | 'draft' | 'permission' | 'noMethod' | 'conflicts' | 'checking' | 'rules'
  reason: string
  /** The viewer may merge anyway, against the rules of the base branch */
  canBypass: boolean
}

type MergeInput = {
  summary: Pick<PrSummary, 'state' | 'isDraft'>
  overview: Pick<
    PrOverview,
    | 'mergeable'
    | 'mergeStateStatus'
    | 'allowedMergeMethods'
    | 'viewerCanMerge'
    | 'viewerCanMergeAsAdmin'
  >
}

/**
 * Why the viewer cannot merge the pull request now, or `undefined` when they
 * can. GitHub rejects the merge in these cases, so the button is not offered.
 */
export function getMergeBlock({ summary, overview }: MergeInput): MergeBlock | undefined {
  const block = (kind: MergeBlock['kind'], reason: string, canBypass = false): MergeBlock => ({
    kind,
    reason,
    canBypass,
  })
  const status = overview.mergeStateStatus

  if (summary.state !== 'OPEN') return block('closed', 'This pull request is not open')
  if (summary.isDraft) return block('draft', 'This pull request is still a draft')
  if (!overview.viewerCanMerge) {
    return block('permission', 'You do not have permission to merge in this repository')
  }
  if (overview.allowedMergeMethods.length === 0) {
    return block('noMethod', 'This repository does not allow merging here')
  }
  if (overview.mergeable === 'CONFLICTING' || status === 'DIRTY') {
    return block('conflicts', 'This branch has conflicts that must be resolved')
  }
  if (overview.mergeable === 'UNKNOWN' || status === 'UNKNOWN') {
    return block('checking', 'GitHub is still checking if this branch can be merged')
  }
  if (status === 'BEHIND') {
    return block(
      'rules',
      'This branch is out of date with the base branch',
      overview.viewerCanMergeAsAdmin,
    )
  }
  if (status === 'BLOCKED') {
    return block(
      'rules',
      'Merging is blocked by the rules of the base branch',
      overview.viewerCanMergeAsAdmin,
    )
  }
  // CLEAN, HAS_HOOKS and UNSTABLE (a check that is not required did not pass)
  return undefined
}
