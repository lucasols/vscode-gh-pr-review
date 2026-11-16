/** The setting: the logins and the slugs of teams that are offered as reviewers, by `owner/repository` */
export type RepoReviewers = Record<string, string[]>

function normalize(name: string): string {
  return name.trim().replace(/^@/, '').toLowerCase()
}

function findKey(setting: RepoReviewers, repo: string): string | undefined {
  const wanted = repo.toLowerCase()
  return Object.keys(setting).find((key) => key.trim().toLowerCase() === wanted)
}

/**
 * Who is offered as a reviewer in a repository, in lower case. Undefined when
 * the setting does not limit the repository, so that everyone is offered.
 */
export function reviewersOf(setting: RepoReviewers, repo: string): Set<string> | undefined {
  const key = findKey(setting, repo)
  const names = key === undefined ? [] : (setting[key] ?? [])
  const reviewers = new Set(names.map(normalize).filter((name) => name !== ''))
  return reviewers.size === 0 ? undefined : reviewers
}

/** The setting with the reviewers of a repository replaced. Without reviewers, it is not limited anymore */
export function withReviewers(
  setting: RepoReviewers,
  repo: string,
  reviewers: readonly string[],
): RepoReviewers {
  const key = findKey(setting, repo)
  const next: RepoReviewers = {}
  for (const [name, value] of Object.entries(setting)) {
    if (name !== key) next[name] = value
  }
  if (reviewers.length > 0) next[key ?? repo] = [...reviewers]
  return next
}
