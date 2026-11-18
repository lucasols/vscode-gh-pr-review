import { namesOf, type RepoSetting } from './repoSetting'

/**
 * Who is offered as a reviewer in a repository, in lower case: logins and
 * slugs of teams, with or without `@` in the setting. Undefined when the
 * setting does not limit the repository, so that everyone is offered.
 */
export function reviewersOf(setting: RepoSetting, repo: string): Set<string> | undefined {
  const reviewers = new Set(
    namesOf(setting, repo)
      .map((name) => name.replace(/^@/, '').trim().toLowerCase())
      .filter((name) => name !== ''),
  )
  return reviewers.size === 0 ? undefined : reviewers
}
