import * as vscode from 'vscode'
import type { Services } from '../services'

/**
 * Shows the pull request of the checked-out branch next to the branch name in
 * the status bar. A click opens its overview and its changes in the side bar.
 */
export class PrStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem
  private readonly subscriptions: vscode.Disposable[] = []

  constructor(private readonly services: Services) {
    // the source control items of the branch have the priority 10000
    this.item = vscode.window.createStatusBarItem(
      'ghPrReview.checkedOutPr',
      vscode.StatusBarAlignment.Left,
      9990,
    )
    this.item.name = 'Pull Request of the Current Branch'

    const { store } = services
    this.subscriptions.push(
      store.onDidChangeLists(() => this.update()),
      store.onDidChangeStatus(() => this.update()),
      store.onDidChangeFocus(() => this.update()),
    )
    this.update()
  }

  private update(): void {
    const { store } = this.services
    const keys = store.getCheckedOutKeys()
    // with several repositories, the one that is being reviewed wins
    const focused = store.focusedKey
    const prKey = focused !== undefined && keys.includes(focused) ? focused : keys[0]
    const pr = prKey ? store.findSummary(prKey) : undefined
    if (!prKey || !pr) {
      this.item.hide()
      return
    }

    this.item.text = `$(git-pull-request) Pull Request #${pr.number}`
    const tooltip = new vscode.MarkdownString()
    tooltip.appendText(`${pr.title}\n`)
    tooltip.appendText(`${pr.repo}#${pr.number} · ${pr.headRefName} → ${pr.baseRefName}`)
    this.item.tooltip = tooltip
    this.item.command = {
      command: 'ghPrReview.reviewPr',
      title: 'Review Pull Request',
      arguments: [prKey],
    }
    this.item.show()
  }

  dispose(): void {
    this.item.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
  }
}
