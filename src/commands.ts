import { relative, sep } from 'node:path'
import * as vscode from 'vscode'
import { config } from './config'
import { docRefPrKey } from './content/docRef'
import { fromDocUri } from './content/ghprFs'
import { checkoutPr } from './git/checkout'
import { parsePrKey, summaryKey, type ReviewEvent } from './model/types'
import type { Services } from './services'
import { errorMessage } from './util/async'
import { repoKey } from './util/remoteUrl'
import { collectNodePaths, isChangesNode, type ChangesView } from './views/changesView'
import { configureQuickAddLabels, configureRepoReviewers } from './views/configureRepo'
import {
  getLocalFileUri,
  openDiffSinceCommit,
  openFileDiff,
  openStackedChanges,
  type DiffMode,
} from './views/diffOpener'
import { warnAboutLocalChanges } from './views/localChanges'
import type { OverviewPanels } from './views/overviewPanel'
import { isListNode } from './views/prListView'

type FileTarget = {
  prKey: string
  paths: string[]
  /** The editor shows a version that the pull request does not have anymore */
  isStale: boolean
}

export function registerCommands(
  services: Services,
  views: { changes: ChangesView; panels: OverviewPanels },
): vscode.Disposable[] {
  const { store, auth } = services

  /** The pull request file that a document shows */
  function targetOfUri(uri: vscode.Uri): FileTarget | undefined {
    const ref = fromDocUri(uri)
    if (ref) {
      const prKey = docRefPrKey(ref)
      const file = store.getDetail(prKey)?.files.find((item) => item.path === ref.path)
      const isStale =
        ref.side === 'head' && ref.blob !== undefined && file?.blobSha !== ref.blob
      return { prKey, paths: [ref.path], isStale }
    }

    if (uri.scheme !== 'file') return undefined
    const candidates = [store.focusedKey, ...store.getCheckedOutKeys()]
    for (const prKey of candidates) {
      if (!prKey) continue
      const repo = store.getRepoForPr(prKey)
      const detail = store.getDetail(prKey)
      if (!repo || !detail || !uri.fsPath.startsWith(repo.rootPath + sep)) continue
      const path = relative(repo.rootPath, uri.fsPath).split(sep).join('/')
      if (detail.files.some((file) => file.path === path)) {
        return { prKey, paths: [path], isStale: false }
      }
    }
    return undefined
  }

  function activeUri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    if (input instanceof vscode.TabInputTextDiff) return input.modified
    if (input instanceof vscode.TabInputText) return input.uri
    return vscode.window.activeTextEditor?.document.uri
  }

  function resolveFileTarget(arg: unknown): FileTarget | undefined {
    if (isChangesNode(arg)) {
      if (arg.kind !== 'file' && arg.kind !== 'folder') return undefined
      return { prKey: arg.prKey, paths: collectNodePaths(arg), isStale: false }
    }
    const uri = arg instanceof vscode.Uri ? arg : activeUri()
    return uri ? targetOfUri(uri) : undefined
  }

  function resolvePrKey(arg: unknown): string | undefined {
    if (typeof arg === 'string' && parsePrKey(arg)) return arg
    if (isListNode(arg) && arg.kind === 'pr') return summaryKey(arg.pr)
    if (isChangesNode(arg)) return arg.prKey
    return store.focusedKey
  }

  async function openDiff(arg: unknown, mode: DiffMode): Promise<void> {
    const target = resolveFileTarget(arg)
    const path = target?.paths[0]
    if (!target || !path) return
    await openFileDiff(services, target.prKey, path, mode)
  }

  async function setViewed(arg: unknown, viewed: boolean): Promise<FileTarget | undefined> {
    const target = resolveFileTarget(arg)
    if (!target) return undefined

    if (viewed && target.isStale) {
      const path = target.paths[0]
      void vscode.window.showWarningMessage(
        'This file changed in the pull request after this editor was opened. The current version was opened instead.',
      )
      if (path) await openFileDiff(services, target.prKey, path, 'auto')
      return undefined
    }

    if (viewed) void warnAboutLocalChanges(services, target.prKey, target.paths)
    await store.setViewed(target.prKey, target.paths, viewed)
    return target
  }

  async function openNextUnviewed(after?: string): Promise<void> {
    const prKey = store.focusedKey
    if (!prKey) return
    const files = views.changes.getOrderedFiles()
    const detail = store.getDetail(prKey)
    const isUnviewed = (path: string) =>
      detail?.files.find((file) => file.path === path)?.viewedState !== 'VIEWED'

    const current = after ?? (() => {
      const uri = activeUri()
      const target = uri ? targetOfUri(uri) : undefined
      return target?.prKey === prKey ? target.paths[0] : undefined
    })()
    const start = current ? files.findIndex((file) => file.path === current) + 1 : 0

    const ordered = [...files.slice(start), ...files.slice(0, start)]
    const next = ordered.find((file) => file.path !== current && isUnviewed(file.path))
    if (!next) {
      void vscode.window.showInformationMessage('All files of the pull request are viewed.')
      return
    }
    await openFileDiff(services, prKey, next.path, 'auto')
  }

  async function submitReview(arg: unknown): Promise<void> {
    const prKey = resolvePrKey(arg)
    const detail = prKey ? store.getDetail(prKey) : undefined
    if (!prKey || !detail) return

    const pending = detail.pendingReview?.commentCount
    type Choice = vscode.QuickPickItem & { event: ReviewEvent }
    const choices: Choice[] = [
      {
        label: '$(comment) Comment',
        detail: 'Submit general feedback without approval',
        event: 'COMMENT',
      },
    ]
    if (!detail.overview.viewerDidAuthor) {
      choices.push(
        {
          label: '$(check) Approve',
          detail: 'Submit feedback and approve merging these changes',
          event: 'APPROVE',
        },
        {
          label: '$(request-changes) Request changes',
          detail: 'Submit feedback that must be addressed before merging',
          event: 'REQUEST_CHANGES',
        },
      )
    }

    const choice = await vscode.window.showQuickPick(choices, {
      title: `Submit review of #${detail.summary.number}`,
      placeHolder:
        pending === undefined ?
          'There are no pending comments'
        : `${pending} pending ${pending === 1 ? 'comment' : 'comments'} will be published`,
    })
    if (!choice) return

    const needsBody =
      choice.event === 'REQUEST_CHANGES' || (choice.event === 'COMMENT' && pending === undefined)
    const body = await vscode.window.showInputBox({
      title: choice.label.replace(/\$\([^)]+\)\s*/, ''),
      prompt: needsBody ? 'Summary of the review' : 'Summary of the review (optional)',
      validateInput: (value) =>
        needsBody && value.trim() === '' ? 'A summary is required' : undefined,
    })
    if (body === undefined) return

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Submitting review…' },
        () => store.submitReview(prKey, choice.event, body),
      )
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not submit the review: ${errorMessage(error)}`,
      )
    }
  }

  async function openPrByNumber(): Promise<void> {
    const repos = store.getRepos()
    if (repos.length === 0) return
    const input = await vscode.window.showInputBox({
      title: 'Open Pull Request',
      prompt: 'Number of the pull request',
      validateInput: (value) =>
        /^#?\d+$/.test(value.trim()) ? undefined : 'Enter a number, for example 150',
    })
    if (!input) return

    let repo = repos[0]
    if (repos.length > 1) {
      const picked = await vscode.window.showQuickPick(
        repos.map((item) => ({ label: repoKey(item.github), repo: item })),
        { title: 'Repository' },
      )
      if (!picked) return
      repo = picked.repo
    }
    if (!repo) return

    const prKey = `${repoKey(repo.github)}#${input.trim().replace('#', '')}`
    views.panels.open(prKey)
  }

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'ghPrReview.refresh': () =>
      vscode.window.withProgress({ location: { viewId: 'ghPrReview.prs' } }, () =>
        store.refreshAll(),
      ),

    'ghPrReview.signIn': async () => {
      if (await auth.signIn()) await store.refreshAll()
    },

    'ghPrReview.openPr': (arg) => {
      const prKey = resolvePrKey(arg)
      if (!prKey) return
      store.focus(prKey)
      views.panels.open(prKey)
    },

    'ghPrReview.reviewPr': async (arg) => {
      const prKey = resolvePrKey(arg)
      if (!prKey) return
      store.focus(prKey)
      // the side bar first, so that the overview ends up with the keyboard focus
      await vscode.commands.executeCommand('ghPrReview.changes.focus')
      views.panels.open(prKey)
    },

    'ghPrReview.openPrByNumber': openPrByNumber,

    'ghPrReview.configureReviewers': () => configureRepoReviewers(services),

    'ghPrReview.configureQuickAddLabels': () => configureQuickAddLabels(services),

    'ghPrReview.openDescription': (arg) => {
      const prKey = resolvePrKey(arg)
      if (prKey) views.panels.open(prKey)
    },

    'ghPrReview.openOnGitHub': async (arg) => {
      const prKey = resolvePrKey(arg)
      const summary = prKey ? store.findSummary(prKey) : undefined
      if (summary) await vscode.env.openExternal(vscode.Uri.parse(summary.url))
    },

    'ghPrReview.copyLink': async (arg) => {
      const prKey = resolvePrKey(arg)
      const summary = prKey ? store.findSummary(prKey) : undefined
      if (summary) await vscode.env.clipboard.writeText(summary.url)
    },

    'ghPrReview.checkout': async (arg) => {
      const prKey = resolvePrKey(arg)
      if (!prKey) return
      try {
        // the Changes view follows the branch
        await checkoutPr(services, prKey)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not check out the pull request: ${errorMessage(error)}`,
        )
      }
    },

    'ghPrReview.openFile': async (prKey, path) => {
      if (typeof prKey !== 'string' || typeof path !== 'string') return
      await openFileDiff(services, prKey, path, 'auto')
    },

    'ghPrReview.openFullDiff': (arg) => openDiff(arg, 'full'),
    'ghPrReview.openChangesSinceViewed': (arg) => openDiff(arg, 'sinceViewed'),

    'ghPrReview.toggleDiffMode': async (arg) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
      const original = input instanceof vscode.TabInputTextDiff ? input.original : undefined
      const ref = original ? fromDocUri(original) : undefined
      // the reviewed version starts from the version that was viewed when it is the default
      const showsSinceViewed =
        ref?.side === 'viewed' ||
        (ref?.side === 'reviewed' && config.defaultDiff() === 'sinceViewed')
      await openDiff(arg, showsSinceViewed ? 'full' : 'sinceViewed')
    },

    'ghPrReview.compareWithCommit': async (arg) => {
      const target = resolveFileTarget(arg)
      const path = target?.paths[0]
      if (!target || !path) return

      try {
        const commits = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Loading commits…' },
          () => store.fetchCommitsOfFile(target.prKey, path),
        )
        if (commits.length === 0) {
          void vscode.window.showInformationMessage(
            'No commit of the pull request changed this file.',
          )
          return
        }
        const picked = await vscode.window.showQuickPick(
          commits.map((commit) => ({
            label: commit.message,
            description: commit.abbreviatedOid,
            detail: new Date(commit.committedDate).toLocaleString(),
            commit,
          })),
          {
            title: `Changes of ${path.slice(path.lastIndexOf('/') + 1)} since a commit`,
            placeHolder:
              'Pick the last commit that you reviewed. The changes made after it are shown.',
          },
        )
        if (picked) await openDiffSinceCommit(services, target.prKey, path, picked.commit)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not load the commits: ${errorMessage(error)}`,
        )
      }
    },

    'ghPrReview.openLocalFile': async (arg) => {
      const target = resolveFileTarget(arg)
      const path = target?.paths[0]
      if (!target || !path) return
      const uri = getLocalFileUri(services, target.prKey, path)
      if (!uri) {
        void vscode.window.showInformationMessage(
          'The repository of this pull request is not open in this window.',
        )
        return
      }
      const selection = vscode.window.activeTextEditor?.selection
      try {
        await vscode.window.showTextDocument(uri, {
          selection: arg instanceof vscode.Uri ? selection : undefined,
        })
      } catch {
        void vscode.window.showWarningMessage(`${path} does not exist in the workspace.`)
      }
    },

    'ghPrReview.copyPath': async (arg) => {
      if (isChangesNode(arg) && (arg.kind === 'file' || arg.kind === 'folder')) {
        await vscode.env.clipboard.writeText(arg.path)
      }
    },

    'ghPrReview.markViewed': (arg) => setViewed(arg, true),
    'ghPrReview.unmarkViewed': (arg) => setViewed(arg, false),

    'ghPrReview.markViewedAndNext': async (arg) => {
      const target = await setViewed(arg, true)
      if (target) await openNextUnviewed(target.paths[0])
    },

    'ghPrReview.openNextUnviewed': () => openNextUnviewed(),

    'ghPrReview.openAllChanges': async () => {
      const prKey = store.focusedKey
      if (!prKey) return
      // the files of the view, so the order and the hidden viewed files match it
      await vscode.window.withProgress({ location: { viewId: 'ghPrReview.changes' } }, () =>
        openStackedChanges(services, prKey, views.changes.getOrderedFiles(), {
          onlyUnviewed: config.hideViewedFiles(),
        }),
      )
    },

    'ghPrReview.openFolderChanges': async (arg) => {
      if (!isChangesNode(arg) || arg.kind !== 'folder') return
      // the folder only has the files that the view shows
      const paths = new Set(collectNodePaths(arg))
      const files = views.changes.getOrderedFiles().filter((file) => paths.has(file.path))
      await vscode.window.withProgress({ location: { viewId: 'ghPrReview.changes' } }, () =>
        openStackedChanges(services, arg.prKey, files, {
          onlyUnviewed: config.hideViewedFiles(),
          folder: arg.path,
        }),
      )
    },

    'ghPrReview.viewAsTree': () => config.setFileLayout('tree'),
    'ghPrReview.viewAsList': () => config.setFileLayout('list'),
    'ghPrReview.hideViewed': () => config.setHideViewedFiles(true),
    'ghPrReview.showViewed': () => config.setHideViewedFiles(false),

    'ghPrReview.submitReview': submitReview,

    'ghPrReview.discardReview': async (arg) => {
      const prKey = resolvePrKey(arg)
      const pending = prKey ? store.getDetail(prKey)?.pendingReview : undefined
      if (!prKey || !pending) return
      const choice = await vscode.window.showWarningMessage(
        `Discard the pending review and its ${pending.commentCount} ${pending.commentCount === 1 ? 'comment' : 'comments'}?`,
        { modal: true },
        'Discard',
      )
      if (choice !== 'Discard') return
      try {
        await store.discardReview(prKey)
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not discard the review: ${errorMessage(error)}`,
        )
      }
    },
  }

  return Object.entries(commands).map(([id, handler]) =>
    vscode.commands.registerCommand(id, handler),
  )
}
