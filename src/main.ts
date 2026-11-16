import { join } from 'node:path'
import * as vscode from 'vscode'
import { registerCommands } from './commands'
import { AUTO_MARK_SETTING, config } from './config'
import { ContentService } from './content/contentService'
import { GHPR_SCHEME, GhprFileSystem } from './content/ghprFs'
import { checkoutPr } from './git/checkout'
import { git } from './git/gitCli'
import { RepoManager } from './git/repos'
import { GitHubApi } from './github/api'
import { Auth } from './github/auth'
import { GitHubClient } from './github/client'
import { initLog, logInfo, logWarn } from './log'
import { BaselineStore, isChangedSinceViewed } from './model/baselines'
import { CHANGE_KIND_LABELS, ChangeClassifier } from './model/changeClassifier'
import { PrStore } from './model/prStore'
import { headBlobId } from './model/types'
import type { Services } from './services'
import { debounce } from './util/async'
import { repoKey } from './util/remoteUrl'
import { ChangesView } from './views/changesView'
import { CommentsController } from './views/comments'
import { TreeDecorationProvider } from './views/decorations'
import { getLocalFileUri, openFileDiff } from './views/diffOpener'
import { OverviewPanels } from './views/overviewPanel'
import { PrListView } from './views/prListView'
import { PrStatusBar } from './views/statusBar'

const FOCUS_KEY = 'focusedPr'
const BRANCHES_KEY = 'branches'
const REFRESH_ON_FOCUS_AFTER_MS = 20_000

/** What the tests of the extension host can inspect */
export type ExtensionApi = {
  services: Services
  comments: CommentsController
  changes: ChangesView
}

function setContext(key: string, value: unknown): void {
  void vscode.commands.executeCommand('setContext', `ghPrReview.${key}`, value)
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  context.subscriptions.push(initLog())
  logInfo('Activating')

  const auth = new Auth()
  const api = new GitHubApi(new GitHubClient(auth, logWarn))

  const baselineStore = new BaselineStore(context.globalState)
  baselineStore.prune()

  const store = new PrStore({
    api,
    baselines: baselineStore,
    getQueries: () => config.queries(),
    notify: (level, message) => {
      if (level === 'error') void vscode.window.showErrorMessage(message)
      else void vscode.window.showWarningMessage(message)
    },
    log: logWarn,
    now: () => Date.now(),
    persistedFocus: {
      get: () => {
        const value = context.workspaceState.get(FOCUS_KEY)
        return typeof value === 'string' ? value : undefined
      },
      set: (key) => void context.workspaceState.update(FOCUS_KEY, key),
    },
    persistedBranches: {
      get: () => context.workspaceState.get(BRANCHES_KEY),
      set: (records) => void context.workspaceState.update(BRANCHES_KEY, records),
    },
  })

  const content = new ContentService(
    api,
    {
      findRoot: (repo) =>
        store
          .getRepos()
          .find((local) =>
            local.remotes.some(
              (remote) => repoKey(remote.repo).toLowerCase() === repo.toLowerCase(),
            ),
          )?.rootPath,
      run: git,
    },
    join(context.globalStorageUri.fsPath, 'blobs'),
  )
  void content.pruneDisk(Date.now())

  const classifier = new ChangeClassifier(content, logWarn)
  const services: Services = { context, store, content, classifier, auth }

  const decorations = new TreeDecorationProvider()
  const changes = new ChangesView(services)
  const prList = new PrListView(services)
  const comments = new CommentsController(services)
  const panels = new OverviewPanels(services, {
    checkout: (prKey) => checkoutPr(services, prKey),
    reviewChanges: async (prKey) => {
      store.focus(prKey)
      await vscode.commands.executeCommand('ghPrReview.changes.focus')
    },
    openFile: (prKey, path) => openFileDiff(services, prKey, path, 'auto'),
  })

  context.subscriptions.push(
    auth,
    changes,
    prList,
    comments,
    panels,
    new PrStatusBar(services),
    { dispose: () => store.dispose() },
    { dispose: () => classifier.dispose() },
    vscode.workspace.registerFileSystemProvider(GHPR_SCHEME, new GhprFileSystem(content), {
      isReadonly: true,
      isCaseSensitive: true,
    }),
    vscode.window.registerFileDecorationProvider(decorations),
    ...registerCommands(services, { changes, panels }),
  )

  // ---- context keys that drive the menus ----

  const updateContext = debounce(() => {
    const focused = store.focusedKey
    const detail = focused ? store.getDetail(focused) : undefined

    setContext('state', store.status)
    setContext('hasFocusedPr', focused !== undefined)
    setContext('hasPendingReview', detail?.pendingReview !== undefined)
    setContext('findingBranchPr', store.isFindingBranchPr)

    // the editors of the files of the focused pull request get review buttons
    const unviewed: Record<string, boolean> = {}
    const viewed: Record<string, boolean> = {}
    const sinceViewed: Record<string, boolean> = {}
    if (focused && detail) {
      const baselines = store.getBaselines(focused)
      for (const file of detail.files) {
        const keys = [`/${file.path}`]
        const local = getLocalFileUri(services, focused, file.path)
        if (local) keys.push(local.fsPath)
        for (const key of keys) {
          if (file.viewedState === 'VIEWED') viewed[key] = true
          else unviewed[key] = true
          if (isChangedSinceViewed(file, baselines[file.path])) sinceViewed[key] = true
        }
      }
    }
    setContext('unviewedEditorPaths', unviewed)
    setContext('viewedEditorPaths', viewed)
    setContext('sinceViewedEditorPaths', sinceViewed)
  }, 20)

  // ---- changes that are not relevant can be marked as viewed automatically ----

  const autoMarked = new Set<string>()
  const autoMarkNonRelevant = () => {
    const kinds = config.autoMarkKinds()
    if (kinds.length === 0) return
    const focused = store.focusedKey
    const detail = focused ? store.getDetail(focused) : undefined
    if (!focused || !detail || detail.summary.state !== 'OPEN') return

    const baselines = store.getBaselines(focused)
    const marked: string[] = []
    for (const file of detail.files) {
      if (file.viewedState === 'VIEWED') continue
      // each version is only marked once, so the user can undo it
      const id = `${focused}|${file.path}|${headBlobId(file) ?? ''}`
      if (autoMarked.has(id)) continue
      const kind = classifier.classify(detail, file, baselines[file.path])
      if (kind === undefined || kind === 'relevant' || !kinds.includes(kind)) continue
      autoMarked.add(id)
      marked.push(file.path)
      logInfo(`Marking ${file.path} as viewed (${CHANGE_KIND_LABELS[kind]})`)
    }
    if (marked.length === 0) return

    void vscode.window.setStatusBarMessage(
      `Marked ${marked.length} ${marked.length === 1 ? 'file' : 'files'} with non-relevant changes as viewed`,
      5000,
    )
    void store.setViewed(focused, marked, true)
  }

  context.subscriptions.push(
    store.onDidChangeStatus(() => updateContext.call()),
    store.onDidChangeFocus(() => {
      updateContext.call()
      autoMarkNonRelevant()
    }),
    store.onDidChangeLists(() => updateContext.call()),
    store.onDidChangeDetail((key) => {
      if (key !== store.focusedKey) return
      updateContext.call()
      autoMarkNonRelevant()
    }),
    classifier.onDidChange((key) => {
      if (key === store.focusedKey) autoMarkNonRelevant()
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (config.affects(event, AUTO_MARK_SETTING)) autoMarkNonRelevant()
      if (config.affects(event, 'queries')) void store.refreshLists()
      if (config.affects(event, 'refreshIntervalSeconds')) startPolling()
    }),
    { dispose: () => updateContext.cancel() },
  )
  updateContext.call()

  // ---- keeping the data fresh ----

  let lastRefresh = 0
  const refresh = () => {
    lastRefresh = Date.now()
    void store.refreshAll()
  }

  let timer: ReturnType<typeof setInterval> | undefined
  function startPolling(): void {
    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      if (vscode.window.state.focused) refresh()
    }, config.refreshIntervalMs())
  }
  startPolling()

  // after a push GitHub needs a moment to update the pull request
  const followUps: ReturnType<typeof setTimeout>[] = []
  const refreshAfterGitChange = debounce(() => {
    refresh()
    for (const followUp of followUps.splice(0)) clearTimeout(followUp)
    followUps.push(setTimeout(refresh, 5000), setTimeout(refresh, 15_000))
  }, 400)

  const repoManager = new RepoManager()
  context.subscriptions.push(
    repoManager,
    repoManager.onDidChange((repos) => {
      store.setRepos([...repos])
      refreshAfterGitChange.call()
    }),
    auth.onDidChange(() => refresh()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && Date.now() - lastRefresh > REFRESH_ON_FOCUS_AFTER_MS) refresh()
    }),
    {
      dispose: () => {
        if (timer) clearInterval(timer)
        refreshAfterGitChange.cancel()
        for (const followUp of followUps) clearTimeout(followUp)
      },
    },
  )
  void repoManager.init()

  return { services, comments, changes }
}

export function deactivate(): void {
  // everything is disposed through the subscriptions of the context
}
