/** A setting that lists names by `owner/repository` */
export type RepoSetting = Record<string, string[]>

function findKey(setting: RepoSetting, repo: string): string | undefined {
  const wanted = repo.toLowerCase()
  return Object.keys(setting).find((key) => key.trim().toLowerCase() === wanted)
}

/** The names that the setting lists for a repository, whatever the case of its key */
export function namesOf(setting: RepoSetting, repo: string): string[] {
  const key = findKey(setting, repo)
  const names = key === undefined ? [] : (setting[key] ?? [])
  return names.map((name) => name.trim()).filter((name) => name !== '')
}

/** The setting with the names of a repository replaced. Without names, the repository is removed */
export function withNames(
  setting: RepoSetting,
  repo: string,
  names: readonly string[],
): RepoSetting {
  const key = findKey(setting, repo)
  const next: RepoSetting = {}
  for (const [name, value] of Object.entries(setting)) {
    if (name !== key) next[name] = value
  }
  if (names.length > 0) next[key ?? repo] = [...names]
  return next
}
