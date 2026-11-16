import * as vscode from 'vscode'
import { logInfo, logWarn } from '../log'
import type { LocalRepo } from '../model/prStore'
import { debounce } from '../util/async'
import { parseGitHubRemote, type RepoRef } from '../util/remoteUrl'

/** The parts of the API of the built-in git extension that are used here */
type GitRemote = { name: string; fetchUrl?: string; pushUrl?: string }
type GitRepositoryState = {
  HEAD: { name?: string; commit?: string } | undefined
  remotes: GitRemote[]
  onDidChange: vscode.Event<void>
}
type GitRepository = { rootUri: vscode.Uri; state: GitRepositoryState }
type GitApi = {
  state: 'uninitialized' | 'initialized'
  repositories: GitRepository[]
  onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>
  onDidOpenRepository: vscode.Event<GitRepository>
  onDidCloseRepository: vscode.Event<GitRepository>
}
type GitExtension = { getAPI: (version: 1) => GitApi }

const PREFERRED_REMOTES = ['origin', 'upstream']

function toLocalRepo(repository: GitRepository): LocalRepo | undefined {
  const remotes: { name: string; repo: RepoRef }[] = []
  for (const remote of repository.state.remotes) {
    const url = remote.fetchUrl ?? remote.pushUrl
    const repo = url ? parseGitHubRemote(url) : undefined
    if (repo) remotes.push({ name: remote.name, repo })
  }

  const primary =
    PREFERRED_REMOTES.map((name) => remotes.find((remote) => remote.name === name)).find(
      (remote) => remote !== undefined,
    ) ?? remotes[0]
  if (!primary) return undefined

  return {
    rootPath: repository.rootUri.fsPath,
    github: primary.repo,
    remotes,
    branch: repository.state.HEAD?.name,
    headSha: repository.state.HEAD?.commit,
  }
}

/**
 * Follows the git repositories of the workspace through the built-in git
 * extension and reports the ones that are hosted on GitHub.
 */
export class RepoManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<LocalRepo[]>()
  readonly onDidChange = this.emitter.event

  private api: GitApi | undefined
  private snapshot = ''
  private repos: LocalRepo[] = []
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly repoSubscriptions = new Map<GitRepository, vscode.Disposable>()
  private readonly update = debounce(() => this.publish(), 150)

  async init(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git')
    if (!extension) {
      logWarn('The built-in git extension is not available')
      this.publish()
      return
    }

    try {
      const exports = extension.isActive ? extension.exports : await extension.activate()
      this.api = exports.getAPI(1)
    } catch (error) {
      logWarn(`The built-in git extension is disabled: ${String(error)}`)
      this.publish()
      return
    }

    const api = this.api
    for (const repository of api.repositories) this.track(repository)
    this.subscriptions.push(
      api.onDidOpenRepository((repository) => {
        this.track(repository)
        this.update.call()
      }),
      api.onDidCloseRepository((repository) => {
        this.repoSubscriptions.get(repository)?.dispose()
        this.repoSubscriptions.delete(repository)
        this.update.call()
      }),
      api.onDidChangeState(() => this.update.call()),
    )

    if (api.state === 'initialized') this.publish()
  }

  private track(repository: GitRepository): void {
    if (this.repoSubscriptions.has(repository)) return
    this.repoSubscriptions.set(
      repository,
      repository.state.onDidChange(() => this.update.call()),
    )
  }

  private publish(): void {
    // while git is still scanning the workspace the list is not complete
    if (this.api && this.api.state !== 'initialized') return

    const repos: LocalRepo[] = []
    for (const repository of this.api?.repositories ?? []) {
      const repo = toLocalRepo(repository)
      if (repo) repos.push(repo)
    }
    repos.sort((a, b) => a.rootPath.localeCompare(b.rootPath))

    const snapshot = JSON.stringify(repos)
    if (snapshot === this.snapshot && this.repos.length > 0) return
    const isFirst = this.snapshot === ''
    if (snapshot === this.snapshot && !isFirst) return

    this.snapshot = snapshot
    this.repos = repos
    logInfo(
      `Repositories: ${repos.map((repo) => `${repo.github.owner}/${repo.github.name}@${repo.branch ?? 'detached'}`).join(', ') || 'none'}`,
    )
    this.emitter.fire(repos)
  }

  getRepos(): readonly LocalRepo[] {
    return this.repos
  }

  dispose(): void {
    this.update.cancel()
    this.emitter.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
    for (const subscription of this.repoSubscriptions.values()) subscription.dispose()
  }
}
