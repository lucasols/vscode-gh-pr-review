import { config } from '../config'
import {
  parsePrKey,
  type LabelChange,
  type Reviewer,
  type ReviewerChange,
} from '../model/types'
import type { Services } from '../services'
import type { OverviewEditOption } from '../shared/overviewProtocol'

/**
 * The options that the dropdown of a section of the overview shows, and what
 * saves the ones that are checked when the dropdown closes.
 */
export type EditSession = {
  options: OverviewEditOption[]
  /** Undefined when the checked options are the ones that were checked already */
  save: (checked: ReadonlySet<string>) => (() => Promise<void>) | undefined
}

/** The checked options first, in the order that they already have */
function checkedFirst<T extends { checked: boolean }>(items: readonly T[]): T[] {
  return [...items.filter((item) => item.checked), ...items.filter((item) => !item.checked)]
}

/** The labels that the pull request can have. The checked ones are the ones it has */
export async function loadLabelEdit(services: Services, prKey: string): Promise<EditSession> {
  const { store } = services
  const available = await store.fetchLabelOptions(prKey)
  // read after the options, so that the checked labels are the latest known
  const labels = store.getDetail(prKey)?.overview.labels ?? []
  const current = new Set(labels.map((label) => label.id))

  const listed = new Set(available.map((option) => option.id))
  const all = [
    ...available,
    ...labels
      .filter((label) => !listed.has(label.id))
      .map((label) => ({ ...label, description: undefined })),
  ]

  return {
    options: checkedFirst(
      all.map((label) => ({
        key: label.id,
        label: label.name,
        description: label.description,
        color: label.color,
        checked: current.has(label.id),
      })),
    ),
    save: (checked) => {
      const known = new Set(all.map((label) => label.id))
      const change: LabelChange = {
        add: [...checked].filter((id) => known.has(id) && !current.has(id)),
        remove: [...current].filter((id) => !checked.has(id)),
      }
      if (change.add.length + change.remove.length === 0) return undefined
      return () => store.updateLabels(prKey, change)
    },
  }
}

const REVIEWER_STATE_TEXT: Record<Reviewer['state'], string> = {
  REQUESTED: 'Review requested',
  APPROVED: 'Approved, check to request again',
  CHANGES_REQUESTED: 'Requested changes, check to request again',
  COMMENTED: 'Commented, check to request again',
  DISMISSED: 'Review dismissed, check to request again',
}

type ReviewerRef = {
  kind: Reviewer['kind']
  slug: string
  /** GraphQL node id. Not known for a request to someone that is not listed */
  id: string | undefined
}

function reviewerKey(reviewer: { kind: Reviewer['kind']; slug: string }): string {
  return `${reviewer.kind}:${reviewer.slug.toLowerCase()}`
}

/**
 * Who can review the pull request. The checked ones are who has a request for
 * a review. When the user picked who is offered in the repository, the others
 * are left out.
 */
export async function loadReviewerEdit(
  services: Services,
  prKey: string,
): Promise<EditSession> {
  const { store } = services
  const repo = parsePrKey(prKey)
  const available = repo ? await store.fetchReviewerOptions(repo) : []
  const offered = repo ? config.reviewers(repo) : undefined
  // read after the options, so that the checked reviewers are the latest known
  const detail = store.getDetail(prKey)
  const author = detail?.summary.author?.login.toLowerCase()
  const reviewers = new Map(
    (detail?.overview.reviewers ?? []).map((reviewer) => [reviewerKey(reviewer), reviewer]),
  )

  const refs = new Map<string, ReviewerRef>()
  const reviewed: OverviewEditOption[] = []
  const others: OverviewEditOption[] = []

  for (const option of available) {
    // the author of a pull request cannot review it
    if (option.kind === 'user' && option.slug.toLowerCase() === author) continue
    const key = reviewerKey(option)
    const reviewer = reviewers.get(key)
    // a reviewer of the pull request stays, so that the request can be removed
    // or made again
    if (offered && !offered.has(option.slug.toLowerCase()) && !reviewer) continue
    refs.set(key, { kind: option.kind, slug: option.slug, id: option.id })
    ;(reviewer ? reviewed : others).push({
      key,
      label: option.kind === 'team' ? (option.name ?? option.slug) : option.slug,
      description:
        [
          option.kind === 'team' ? 'Team' : option.name,
          reviewer && REVIEWER_STATE_TEXT[reviewer.state],
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      avatarUrl: option.avatarUrl,
      checked: reviewer?.state === 'REQUESTED',
    })
  }

  // a request can be for someone that is not listed, like a bot. It is shown
  // so that it can be removed
  for (const [key, reviewer] of reviewers) {
    if (refs.has(key) || reviewer.state !== 'REQUESTED') continue
    refs.set(key, { kind: reviewer.kind, slug: reviewer.slug, id: undefined })
    reviewed.push({
      key,
      label: reviewer.name,
      description: REVIEWER_STATE_TEXT.REQUESTED,
      avatarUrl: reviewer.avatarUrl,
      checked: true,
    })
  }

  const options = checkedFirst([...reviewed, ...others])
  const requested = new Set(
    options.filter((option) => option.checked).map((option) => option.key),
  )

  return {
    options,
    save: (checked) => {
      const change: ReviewerChange = {
        add: { userIds: [], teamIds: [] },
        remove: { logins: [], teamSlugs: [] },
      }
      for (const [key, reviewer] of refs) {
        if (checked.has(key) === requested.has(key)) continue
        if (requested.has(key)) {
          if (reviewer.kind === 'team') change.remove.teamSlugs.push(reviewer.slug)
          else change.remove.logins.push(reviewer.slug)
        } else if (reviewer.id !== undefined) {
          if (reviewer.kind === 'team') change.add.teamIds.push(reviewer.id)
          else change.add.userIds.push(reviewer.id)
        }
      }

      const count =
        change.add.userIds.length +
        change.add.teamIds.length +
        change.remove.logins.length +
        change.remove.teamSlugs.length
      if (count === 0) return undefined
      return () => store.updateReviewers(prKey, change)
    },
  }
}
