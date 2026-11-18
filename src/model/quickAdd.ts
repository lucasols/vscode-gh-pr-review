import type { LabelOption, Reviewer, ReviewerOption } from './types'

function reviewerKey(reviewer: { kind: Reviewer['kind']; slug: string }): string {
  return `${reviewer.kind}:${reviewer.slug.toLowerCase()}`
}

/**
 * Who a review can be requested from with one click: the ones that the user
 * picked for the repository and that are not reviewers of the pull request
 * yet. Someone who already reviewed gets a new request in the dropdown.
 */
export function reviewersToOffer(args: {
  /** Logins and slugs of teams, in lower case */
  offered: ReadonlySet<string>
  options: readonly ReviewerOption[]
  reviewers: readonly Reviewer[]
  /** The login of the author, who cannot review their own pull request */
  author: string | undefined
}): ReviewerOption[] {
  const author = args.author?.toLowerCase()
  const taken = new Set(args.reviewers.map(reviewerKey))
  return args.options.filter((option) => {
    const slug = option.slug.toLowerCase()
    if (option.kind === 'user' && slug === author) return false
    return args.offered.has(slug) && !taken.has(reviewerKey(option))
  })
}

/**
 * The labels that are added with one click: the ones of the setting that the
 * repository has and the pull request does not, in the order of the setting.
 */
export function labelsToOffer(args: {
  names: readonly string[]
  options: readonly LabelOption[]
  labels: readonly { id: string }[]
}): LabelOption[] {
  const byName = new Map(args.options.map((option) => [option.name.toLowerCase(), option]))
  const taken = new Set(args.labels.map((label) => label.id))
  const offered: LabelOption[] = []
  for (const name of args.names) {
    const option = byName.get(name.toLowerCase())
    if (!option || taken.has(option.id)) continue
    taken.add(option.id)
    offered.push(option)
  }
  return offered
}
