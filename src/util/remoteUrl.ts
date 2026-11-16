export type RepoRef = { owner: string; name: string }

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com'])

function splitPath(path: string): RepoRef | undefined {
  const parts = path
    .replace(/^\/+/, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '')
    .split('/')
  const [owner, name] = parts
  if (parts.length !== 2 || !owner || !name) return undefined
  return { owner, name }
}

/**
 * Reads the GitHub repository of a git remote URL. Supports HTTPS, SSH and
 * scp-like URLs, including SSH host aliases that mention github (for example
 * `git@github-work:owner/repo.git`).
 */
export function parseGitHubRemote(url: string): RepoRef | undefined {
  const trimmed = url.trim()
  if (!trimmed) return undefined

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return undefined
    }
    if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return undefined
    return splitPath(parsed.pathname)
  }

  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed)
  if (!scp) return undefined
  const host = scp[1]?.toLowerCase()
  const path = scp[2]
  if (!host || !path) return undefined
  if (!GITHUB_HOSTS.has(host) && !host.includes('github')) return undefined
  return splitPath(path)
}

export function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`
}

export function parseRepoKey(key: string): RepoRef | undefined {
  return splitPath(key)
}
