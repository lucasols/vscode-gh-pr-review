import { basename } from 'node:path'
import * as vscode from 'vscode'
import type { PrCategory } from '../github/api'
import type { LocalRepo } from '../model/prStore'
import { summaryKey, type PrSummary } from '../model/types'
import type { Services } from '../services'
import { debounce } from '../util/async'
import { toTreePrUri } from './decorations'

export type ListNode =
  | { kind: 'repo'; repo: LocalRepo }
  | { kind: 'category'; repo: LocalRepo; index: number; category: PrCategory }
  | { kind: 'pr'; repo: LocalRepo; categoryIndex: number; pr: PrSummary }

const nodeRegistry = new WeakSet<object>()

export function isListNode(value: unknown): value is ListNode {
  return typeof value === 'object' && value !== null && nodeRegistry.has(value)
}

function register<T extends ListNode>(node: T): T {
  nodeRegistry.add(node)
  return node
}

/** The list of the pull requests of the repository, grouped by search query */
export class PrListView implements vscode.TreeDataProvider<ListNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.emitter.event

  private readonly treeView: vscode.TreeView<ListNode>
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly refreshSoon = debounce(() => this.refresh(), 30)

  constructor(private readonly services: Services) {
    this.treeView = vscode.window.createTreeView('ghPrReview.prs', {
      treeDataProvider: this,
      showCollapseAll: true,
    })

    const { store } = services
    this.subscriptions.push(
      this.treeView,
      this.emitter,
      store.onDidChangeLists(() => this.refreshSoon.call()),
      store.onDidChangeStatus(() => this.refreshSoon.call()),
      store.onDidChangeFocus(() => this.refreshSoon.call()),
    )
    this.refresh()
  }

  private refresh(): void {
    const { store } = this.services
    const errors = store
      .getRepos()
      .map((repo) => store.getLists(repo.rootPath)?.error)
      .filter((error) => error !== undefined)

    if (store.status !== 'ready') {
      this.treeView.message = undefined
    } else if (errors.length > 0) {
      this.treeView.message = `Could not refresh: ${errors[0]}`
    } else if (store.getRepos().some((repo) => !store.getLists(repo.rootPath))) {
      this.treeView.message = 'Loading…'
    } else {
      this.treeView.message = undefined
    }
    this.emitter.fire()
  }

  private categories(repo: LocalRepo): ListNode[] {
    const lists = this.services.store.getLists(repo.rootPath)
    return (lists?.categories ?? []).map((category, index) =>
      register({ kind: 'category', repo, index, category }),
    )
  }

  getChildren(node?: ListNode): ListNode[] {
    const { store } = this.services
    if (store.status !== 'ready') return []

    if (!node) {
      const repos = store.getRepos()
      const [only] = repos
      if (repos.length === 1 && only) return this.categories(only)
      return repos.map((repo) => register({ kind: 'repo', repo }))
    }

    if (node.kind === 'repo') return this.categories(node.repo)
    if (node.kind === 'category') {
      return node.category.prs.map((pr) =>
        register({ kind: 'pr', repo: node.repo, categoryIndex: node.index, pr }),
      )
    }
    return []
  }

  getTreeItem(node: ListNode): vscode.TreeItem {
    const { store } = this.services

    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(
        `${node.repo.github.owner}/${node.repo.github.name}`,
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.id = `repo|${node.repo.rootPath}`
      item.description = basename(node.repo.rootPath)
      item.iconPath = new vscode.ThemeIcon('repo')
      return item
    }

    if (node.kind === 'category') {
      const item = new vscode.TreeItem(
        node.category.label,
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.id = `category|${node.repo.rootPath}|${node.index}|${node.category.label}`
      const shown = node.category.prs.length
      item.description =
        node.category.totalCount > shown ?
          `${shown} of ${node.category.totalCount}`
        : String(shown)
      item.tooltip = node.category.query
      item.iconPath = vscode.ThemeIcon.Folder
      return item
    }

    const { pr } = node
    const key = summaryKey(pr)
    const isCheckedOut = store.getCheckoutOf(key) !== undefined
    const isFocused = store.focusedKey === key

    const item = new vscode.TreeItem(toTreePrUri(key, pr.checkState))
    item.id = `pr|${node.repo.rootPath}|${node.categoryIndex}|${key}`
    item.label = `${isCheckedOut ? '✓ ' : ''}${pr.title}`
    item.description = `#${pr.number}${pr.author ? ` by @${pr.author.login}` : ''}${pr.isDraft ? ' · draft' : ''}`
    item.iconPath =
      pr.author?.avatarUrl ?
        vscode.Uri.parse(pr.author.avatarUrl)
      : new vscode.ThemeIcon('git-pull-request')
    item.contextValue = ['pr', isCheckedOut ? 'checkedOut' : '', isFocused ? 'focused' : '']
      .filter(Boolean)
      .join(' ')
    item.command = {
      command: 'ghPrReview.openPr',
      title: 'Open Pull Request',
      arguments: [key],
    }

    const tooltip = new vscode.MarkdownString()
    tooltip.appendMarkdown(`**#${pr.number}** `)
    tooltip.appendText(pr.title)
    tooltip.appendMarkdown('\n\n')
    tooltip.appendText(`${pr.headRefName} → ${pr.baseRefName}`)
    const facts: string[] = []
    if (pr.isDraft) facts.push('Draft')
    if (pr.reviewDecision === 'APPROVED') facts.push('Approved')
    if (pr.reviewDecision === 'CHANGES_REQUESTED') facts.push('Changes requested')
    if (pr.reviewDecision === 'REVIEW_REQUIRED') facts.push('Review required')
    if (pr.checkState === 'SUCCESS') facts.push('Checks passed')
    if (pr.checkState === 'FAILURE') facts.push('Checks failed')
    if (pr.checkState === 'PENDING') facts.push('Checks running')
    if (isCheckedOut) facts.push('Checked out')
    if (facts.length > 0) {
      tooltip.appendMarkdown('\n\n')
      tooltip.appendText(facts.join(' · '))
    }
    item.tooltip = tooltip

    return item
  }

  dispose(): void {
    this.refreshSoon.cancel()
    for (const subscription of this.subscriptions) subscription.dispose()
  }
}
