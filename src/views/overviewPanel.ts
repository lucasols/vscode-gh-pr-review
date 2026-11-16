import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import type { Disposable } from '../util/emitter'
import { getMergeBlock } from '../model/mergeBlock'
import type { MergeMethod, PrDetail, ReviewEvent } from '../model/types'
import type { Services } from '../services'
import {
  fromWebviewMessageSchema,
  overviewPersistedSchema,
  type FromWebviewMessage,
  type OverviewEditField,
  type ToWebviewMessage,
} from '../shared/overviewProtocol'
import { errorMessage } from '../util/async'
import css from '../webview/overview.css'
import { loadLabelEdit, loadReviewerEdit, type EditSession } from './editOptions'
import { buildOverviewState } from './overviewState'

const VIEW_TYPE = 'ghPrReview.overview'

const MERGE_VERBS: Record<MergeMethod, string> = {
  MERGE: 'a merge commit',
  SQUASH: 'squash and merge',
  REBASE: 'rebase and merge',
}

export type OverviewActions = {
  checkout: (prKey: string) => Promise<void>
  reviewChanges: (prKey: string) => Promise<void>
  openFile: (prKey: string, path: string) => Promise<void>
}

type OpenPanel = {
  panel: vscode.WebviewPanel
  watch: Disposable
  ready: boolean
  /** The dropdown that is open in the page, with what its options stand for */
  edit: { field: OverviewEditField; session: EditSession | undefined } | undefined
}

const EDITS: Record<
  OverviewEditField,
  {
    action: string
    failure: string
    load: (services: Services, prKey: string) => Promise<EditSession>
  }
> = {
  labels: {
    action: 'editLabels',
    failure: 'Could not update the labels',
    load: loadLabelEdit,
  },
  reviewers: {
    action: 'editReviewers',
    failure: 'Could not update the reviewers',
    load: loadReviewerEdit,
  },
}

function panelTitle(prKey: string, detail: PrDetail | undefined, title?: string): string {
  const number = prKey.slice(prKey.lastIndexOf('#') + 1)
  const text = detail?.summary.title ?? title ?? ''
  const short = text.length > 28 ? `${text.slice(0, 27)}…` : text
  return `#${number} ${short}`.trim()
}

/** The tabs that show the description, the checks and the merge box of a pull request */
export class OverviewPanels implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private readonly panels = new Map<string, OpenPanel>()
  private readonly subscriptions: vscode.Disposable[] = []

  constructor(
    private readonly services: Services,
    private readonly actions: OverviewActions,
  ) {
    const { store } = services
    this.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, this),
      store.onDidChangeDetail((key) => this.post(key)),
      store.onDidChangeLists(() => {
        for (const key of this.panels.keys()) this.post(key)
      }),
    )
  }

  open(prKey: string, options: { preserveFocus?: boolean } = {}): void {
    const existing = this.panels.get(prKey)
    if (existing) {
      existing.panel.reveal(undefined, options.preserveFocus)
      return
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      panelTitle(prKey, undefined, this.services.store.findSummary(prKey)?.title),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: options.preserveFocus },
      this.webviewOptions(),
    )
    this.attach(prKey, panel)
  }

  /** Restores a tab that was open when VS Code closed */
  deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Thenable<void> {
    const parsed = overviewPersistedSchema.safeParse(state)
    if (!parsed.success || this.panels.has(parsed.data.prKey)) {
      panel.dispose()
      return Promise.resolve()
    }
    panel.webview.options = this.webviewOptions()
    this.attach(parsed.data.prKey, panel)
    return Promise.resolve()
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.services.context.extensionUri, 'dist', 'webview'),
      ],
    }
  }

  private attach(prKey: string, panel: vscode.WebviewPanel): void {
    const open: OpenPanel = {
      panel,
      watch: this.services.store.watch(prKey),
      ready: false,
      edit: undefined,
    }
    this.panels.set(prKey, open)

    panel.webview.onDidReceiveMessage((data: unknown) => {
      const parsed = fromWebviewMessageSchema.safeParse(data)
      if (parsed.success) void this.handle(prKey, open, parsed.data)
    })
    panel.onDidDispose(() => {
      open.watch.dispose()
      if (this.panels.get(prKey) === open) this.panels.delete(prKey)
    })
    panel.webview.html = this.html(panel.webview)
  }

  private send(open: OpenPanel, message: ToWebviewMessage): void {
    void open.panel.webview.postMessage(message)
  }

  private post(prKey: string): void {
    const open = this.panels.get(prKey)
    if (!open?.ready) return
    const { store } = this.services

    const detail = store.getDetail(prKey)
    open.panel.title = panelTitle(prKey, detail, store.findSummary(prKey)?.title)

    if (!detail) {
      this.send(open, { type: 'loading', prKey, error: store.getDetailError(prKey) })
      return
    }

    this.send(open, {
      type: 'state',
      state: buildOverviewState({
        prKey,
        detail,
        isCheckedOut: store.getCheckoutOf(prKey) !== undefined,
        canCheckout: store.getRepoForPr(prKey) !== undefined,
        refreshError: store.getDetailError(prKey),
      }),
    })
  }

  private async run(
    open: OpenPanel,
    action: string,
    failure: string,
    task: () => Promise<void>,
  ): Promise<void> {
    this.send(open, { type: 'busy', action })
    try {
      await task()
      this.send(open, { type: 'done', action })
    } catch (error) {
      void vscode.window.showErrorMessage(`${failure}: ${errorMessage(error)}`)
    } finally {
      this.send(open, { type: 'busy' })
    }
  }

  private async handle(
    prKey: string,
    open: OpenPanel,
    message: FromWebviewMessage,
  ): Promise<void> {
    const { store } = this.services
    const summary = store.findSummary(prKey)

    switch (message.type) {
      case 'ready':
        open.ready = true
        this.post(prKey)
        return

      case 'refresh':
        await this.run(open, 'refresh', 'Could not refresh', async () => {
          await Promise.all([store.refreshDetail(prKey), store.refreshLists()])
        })
        return

      case 'checkout':
        await this.run(open, 'checkout', 'Could not check out the pull request', () =>
          this.actions.checkout(prKey),
        )
        this.post(prKey)
        return

      case 'reviewChanges':
        await this.actions.reviewChanges(prKey)
        return

      case 'openFile':
        await this.actions.openFile(prKey, message.path)
        return

      case 'openOnGitHub':
        if (summary) await vscode.env.openExternal(vscode.Uri.parse(summary.url))
        return

      case 'copyLink':
        if (summary) {
          await vscode.env.clipboard.writeText(summary.url)
          void vscode.window.setStatusBarMessage('Copied the link of the pull request', 3000)
        }
        return

      case 'merge':
        await this.merge(prKey, open, message.method)
        return

      case 'enableAutoMerge':
        await this.enableAutoMerge(prKey, open, message.method)
        return

      case 'disableAutoMerge':
        await this.run(open, 'disableAutoMerge', 'Could not disable auto-merge', () =>
          store.disableAutoMerge(prKey),
        )
        return

      case 'readyForReview':
        await this.run(open, 'readyForReview', 'Could not update the pull request', () =>
          store.markReadyForReview(prKey),
        )
        return

      case 'loadEditOptions': {
        const { field } = message
        // another dropdown can open before the options of this one arrive
        const edit: OpenPanel['edit'] = { field, session: undefined }
        open.edit = edit
        try {
          const session = await EDITS[field].load(this.services, prKey)
          if (open.edit !== edit) return
          edit.session = session
          this.send(open, { type: 'editOptions', field, options: session.options })
        } catch (error) {
          if (open.edit !== edit) return
          open.edit = undefined
          this.send(open, { type: 'editOptions', field, error: errorMessage(error) })
        }
        return
      }

      case 'applyEdit': {
        const edit = open.edit
        if (edit?.field !== message.field) return
        open.edit = undefined
        const save = edit.session?.save(new Set(message.checked))
        if (!save) return
        const { action, failure } = EDITS[message.field]
        await this.run(open, action, failure, save)
        return
      }

      case 'comment':
        await this.run(open, 'comment', 'Could not add the comment', () =>
          store.addIssueComment(prKey, message.body),
        )
        return

      case 'review':
        await this.submitReview(prKey, open, message.event, message.body)
        return
    }
  }

  private async merge(prKey: string, open: OpenPanel, method: MergeMethod): Promise<void> {
    const detail = this.services.store.getDetail(prKey)
    if (!detail) return
    const { summary } = detail

    // the page disables the button, but its state can be older than the store
    const block = getMergeBlock(detail)
    if (block && !block.canBypass) {
      void vscode.window.showErrorMessage(
        `Could not merge the pull request: ${block.reason}.`,
      )
      return
    }

    const warnings: string[] = []
    if (block) warnings.push(`${block.reason}. This merge bypasses it.`)
    if (summary.checkState === 'FAILURE') warnings.push('Some checks failed.')
    if (summary.checkState === 'PENDING') warnings.push('Some checks are still running.')
    if (summary.reviewDecision === 'CHANGES_REQUESTED') warnings.push('Changes were requested.')
    if (detail.pendingReview) warnings.push('You have a pending review that is not submitted.')

    const choice = await vscode.window.showWarningMessage(
      `Merge #${summary.number} into ${summary.baseRefName} with ${MERGE_VERBS[method]}?`,
      {
        modal: true,
        detail: [summary.title, ...warnings].join('\n'),
      },
      'Merge',
    )
    if (choice !== 'Merge') return

    await this.run(open, 'merge', 'Could not merge the pull request', async () => {
      await this.services.store.merge(prKey, method)
      void vscode.window.showInformationMessage(
        `Merged #${summary.number} into ${summary.baseRefName}.`,
      )
    })
  }

  private async enableAutoMerge(
    prKey: string,
    open: OpenPanel,
    method: MergeMethod,
  ): Promise<void> {
    const detail = this.services.store.getDetail(prKey)
    if (!detail) return
    const { summary } = detail

    const choice = await vscode.window.showWarningMessage(
      `Enable auto-merge of #${summary.number} into ${summary.baseRefName} with ${MERGE_VERBS[method]}?`,
      {
        modal: true,
        detail: [
          summary.title,
          'GitHub merges the pull request on its own when its requirements are met.',
        ].join('\n'),
      },
      'Enable Auto-Merge',
    )
    if (choice !== 'Enable Auto-Merge') return

    await this.run(open, 'enableAutoMerge', 'Could not enable auto-merge', () =>
      this.services.store.enableAutoMerge(prKey, method),
    )
  }

  private async submitReview(
    prKey: string,
    open: OpenPanel,
    event: ReviewEvent,
    body: string,
  ): Promise<void> {
    await this.run(open, `review:${event}`, 'Could not submit the review', () =>
      this.services.store.submitReview(prKey, event, body),
    )
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64')
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.services.context.extensionUri, 'dist', 'webview', 'overview.js'),
    )
    const csp = [
      "default-src 'none'",
      'img-src https: data:',
      'media-src https:',
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ')

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
</head>
<body>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`
  }

  dispose(): void {
    for (const open of this.panels.values()) open.panel.dispose()
    this.panels.clear()
    for (const subscription of this.subscriptions) subscription.dispose()
  }
}
