import * as vscode from 'vscode'
import { config } from '../config'
import type { LocalRepo } from '../model/prStore'
import type { Services } from '../services'
import { errorMessage } from '../util/async'
import { repoKey } from '../util/remoteUrl'

/** `name` is what the setting stores for the item */
type NameItem = vscode.QuickPickItem & { name: string }

async function pickRepo(services: Services): Promise<LocalRepo | undefined> {
  const repos = services.store.getRepos()
  if (repos.length === 0) {
    void vscode.window.showInformationMessage(
      'No GitHub repository was found in this workspace.',
    )
    return undefined
  }
  if (repos.length === 1) return repos[0]
  const picked = await vscode.window.showQuickPick(
    repos.map((repo) => ({ label: repoKey(repo.github), repo })),
    { title: 'Repository' },
  )
  return picked?.repo
}

/**
 * Asks which of the items of a repository are checked. The ones that are
 * checked already come first. Undefined when it is cancelled.
 */
async function pickNames(args: {
  title: string
  placeholder: string
  failure: string
  load: () => Promise<NameItem[]>
  isChecked: (item: NameItem) => boolean
}): Promise<string[] | undefined> {
  // shown right away, and filled when the items are loaded
  const quickPick = vscode.window.createQuickPick<NameItem>()
  quickPick.title = args.title
  quickPick.placeholder = 'Loading…'
  quickPick.canSelectMany = true
  quickPick.matchOnDescription = true
  quickPick.busy = true
  quickPick.show()

  const picked = await new Promise<readonly NameItem[] | undefined>((resolve) => {
    let isLoaded = false
    quickPick.onDidAccept(() => {
      if (isLoaded) resolve(quickPick.selectedItems)
    })
    quickPick.onDidHide(() => resolve(undefined))

    void args.load().then(
      (items) => {
        quickPick.items = [
          ...items.filter(args.isChecked),
          ...items.filter((item) => !args.isChecked(item)),
        ]
        quickPick.selectedItems = quickPick.items.filter(args.isChecked)
        quickPick.placeholder = args.placeholder
        quickPick.busy = false
        isLoaded = true
      },
      (error: unknown) => {
        void vscode.window.showErrorMessage(`${args.failure}: ${errorMessage(error)}`)
        resolve(undefined)
      },
    )
  })

  quickPick.dispose()
  return picked?.map((item) => item.name)
}

/**
 * Asks who is offered as a reviewer in the pull requests of a repository of
 * the workspace. The answer is stored in the user settings
 * (`ghPrReview.reviewers`), so it applies to every clone of the repository.
 */
export async function configureRepoReviewers(services: Services): Promise<void> {
  const repo = await pickRepo(services)
  if (!repo) return
  const name = repoKey(repo.github)
  const offered = config.reviewers(repo.github)

  const picked = await pickNames({
    title: `Reviewers of ${name}`,
    placeholder: 'Check who is offered as a reviewer. With no one checked, everyone is',
    failure: 'Could not load the reviewers',
    load: async () => {
      const options = await services.store.fetchReviewerOptions(repo.github)
      return options.map((option) => ({
        name: option.slug,
        label: option.kind === 'team' ? (option.name ?? option.slug) : option.slug,
        description: option.kind === 'team' ? 'Team' : option.name,
        iconPath:
          option.avatarUrl ?
            vscode.Uri.parse(option.avatarUrl)
          : new vscode.ThemeIcon(option.kind === 'team' ? 'organization' : 'account'),
      }))
    },
    isChecked: (item) => offered?.has(item.name.toLowerCase()) === true,
  })
  if (!picked) return

  await config.setReviewers(repo.github, picked)

  const count = picked.length
  void vscode.window.setStatusBarMessage(
    count === 0 ?
      `Everyone is offered as a reviewer in ${name}`
    : `${count} ${count === 1 ? 'reviewer is' : 'reviewers are'} offered in ${name}`,
    5000,
  )
}

/**
 * Asks which labels of a repository of the workspace the overview adds with
 * one click. The answer is stored in the user settings
 * (`ghPrReview.quickAddLabels`).
 */
export async function configureQuickAddLabels(services: Services): Promise<void> {
  const repo = await pickRepo(services)
  if (!repo) return
  const name = repoKey(repo.github)
  const current = new Set(
    config.quickAddLabels(repo.github).map((label) => label.toLowerCase()),
  )

  const picked = await pickNames({
    title: `Quick add labels of ${name}`,
    placeholder: 'Check the labels that the overview adds with one click',
    failure: 'Could not load the labels',
    load: async () => {
      const options = await services.store.fetchLabelOptions(repo.github)
      return options.map((option) => ({
        name: option.name,
        label: option.name,
        description: option.description,
        iconPath: new vscode.ThemeIcon('tag'),
      }))
    },
    isChecked: (item) => current.has(item.name.toLowerCase()),
  })
  if (!picked) return

  await config.setQuickAddLabels(repo.github, picked)

  const count = picked.length
  void vscode.window.setStatusBarMessage(
    count === 0 ?
      `No label is added with one click in ${name}`
    : `${count} ${count === 1 ? 'label is' : 'labels are'} added with one click in ${name}`,
    5000,
  )
}
