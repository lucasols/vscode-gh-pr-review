import * as vscode from 'vscode'
import type { Services } from '../services'
import { repoKey } from '../util/remoteUrl'
import { git, gitSucceeds, gitText } from './gitCli'

/** Checks out the branch of a pull request in the local clone of its repository */
export async function checkoutPr(services: Services, prKey: string): Promise<void> {
  const { store } = services
  const repo = store.getRepoForPr(prKey)
  const pr = store.findSummary(prKey)
  if (!repo || !pr) {
    throw new Error('The repository of this pull request is not open in this window')
  }

  const remote = repo.remotes.find(
    (item) => repoKey(item.repo).toLowerCase() === pr.repo.toLowerCase(),
  )
  if (!remote) throw new Error(`No git remote points to ${pr.repo}`)
  const root = repo.rootPath

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Checking out #${pr.number}…`,
    },
    async () => {
      if (!pr.isCrossRepository) {
        const branch = pr.headRefName
        await git(root, ['fetch', remote.name, branch])
        const exists = await gitSucceeds(root, [
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/heads/${branch}`,
        ])
        if (!exists) {
          await git(root, ['checkout', '-b', branch, '--track', `${remote.name}/${branch}`])
          return
        }
        await git(root, ['checkout', branch])
        const updated = await gitSucceeds(root, [
          'merge',
          '--ff-only',
          `${remote.name}/${branch}`,
        ])
        if (!updated) {
          void vscode.window.showWarningMessage(
            `The local branch ${branch} has commits that are not in the pull request, so it was not updated.`,
          )
        }
        return
      }

      // the branch of a fork is fetched through the pull request ref
      const branch = `pr/${pr.headRepoOwner ?? 'fork'}/${pr.number}`
      const current = await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (current === branch) {
        await git(root, ['fetch', remote.name, `pull/${pr.number}/head`])
        await git(root, ['merge', '--ff-only', 'FETCH_HEAD'])
        return
      }
      await git(root, ['fetch', remote.name, `+pull/${pr.number}/head:${branch}`])
      await git(root, ['checkout', branch])
    },
  )
}
