import * as vscode from 'vscode'
import { config } from '../config'
import type { LocalRepo } from '../model/prStore'
import type { Services } from '../services'
import { errorMessage } from '../util/async'
import { repoKey } from '../util/remoteUrl'

type ReviewerItem = vscode.QuickPickItem & { slug: string }

async function pickRepo(repos: readonly LocalRepo[]): Promise<LocalRepo | undefined> {
  if (repos.length <= 1) return repos[0]
  const picked = await vscode.window.showQuickPick(
    repos.map((repo) => ({ label: repoKey(repo.github), repo })),
    { title: 'Repository' },
  )
  return picked?.repo
}

/**
 * Asks who is offered as a reviewer in the pull requests of a repository of
 * the workspace. The answer is stored in the user settings
 * (`ghPrReview.reviewers`), so it applies to every clone of the repository.
 */
export async function configureRepoReviewers(services: Services): Promise<void> {
  const { store } = services
  const repos = store.getRepos()
  if (repos.length === 0) {
    void vscode.window.showInformationMessage(
      'No GitHub repository was found in this workspace.',
    )
    return
  }
  const repo = await pickRepo(repos)
  if (!repo) return
  const name = repoKey(repo.github)

  // shown right away, and filled when the reviewers are loaded
  const quickPick = vscode.window.createQuickPick<ReviewerItem>()
  quickPick.title = `Reviewers of ${name}`
  quickPick.placeholder = 'Loading…'
  quickPick.canSelectMany = true
  quickPick.matchOnDescription = true
  quickPick.busy = true
  quickPick.show()

  const picked = await new Promise<readonly ReviewerItem[] | undefined>((resolve) => {
    let isLoaded = false
    quickPick.onDidAccept(() => {
      if (isLoaded) resolve(quickPick.selectedItems)
    })
    quickPick.onDidHide(() => resolve(undefined))

    void store.fetchReviewerOptions(repo.github).then(
      (options) => {
        const offered = config.reviewers(repo.github)
        const isOffered = (item: ReviewerItem) =>
          offered?.has(item.slug.toLowerCase()) === true
        const items = options.map(
          (option): ReviewerItem => ({
            slug: option.slug,
            label: option.kind === 'team' ? (option.name ?? option.slug) : option.slug,
            description: option.kind === 'team' ? 'Team' : option.name,
            iconPath:
              option.avatarUrl ?
                vscode.Uri.parse(option.avatarUrl)
              : new vscode.ThemeIcon(option.kind === 'team' ? 'organization' : 'account'),
          }),
        )

        // the ones that are offered first
        quickPick.items = [
          ...items.filter(isOffered),
          ...items.filter((item) => !isOffered(item)),
        ]
        quickPick.selectedItems = quickPick.items.filter(isOffered)
        quickPick.placeholder =
          'Check who is offered as a reviewer. With no one checked, everyone is'
        quickPick.busy = false
        isLoaded = true
      },
      (error: unknown) => {
        void vscode.window.showErrorMessage(
          `Could not load the reviewers: ${errorMessage(error)}`,
        )
        resolve(undefined)
      },
    )
  })

  quickPick.dispose()
  if (!picked) return

  await config.setReviewers(
    repo.github,
    picked.map((item) => item.slug),
  )

  const count = picked.length
  void vscode.window.setStatusBarMessage(
    count === 0 ?
      `Everyone is offered as a reviewer in ${name}`
    : `${count} ${count === 1 ? 'reviewer is' : 'reviewers are'} offered in ${name}`,
    5000,
  )
}
