import { z } from 'zod'
import type { GitHubApi, DiffCache, ListQuery, PrCategory, PrCommit } from '../github/api'
import { GitHubError } from '../github/client'
import { SerialTask, errorMessage } from '../util/async'
import { Emitter, type Disposable } from '../util/emitter'
import { repoKey, type RepoRef } from '../util/remoteUrl'
import {
  markViewedBaselines,
  reconcileBaselines,
  removeBaselines,
  type BaselineMap,
  type BaselineStore,
} from './baselines'
import {
  headBlobId,
  parsePrKey,
  summaryKey,
  type DiffSide,
  type LabelChange,
  type LabelOption,
  type MergeMethod,
  type PrDetail,
  type PrFile,
  type PrSummary,
  type ReviewEvent,
  type ReviewerChange,
  type ReviewerOption,
  type ViewedState,
} from './types'

export type LocalRepo = {
  /** Path of the root folder of the repository in the file system */
  rootPath: string
  /** The GitHub repository whose pull requests are listed */
  github: RepoRef
  remotes: { name: string; repo: RepoRef }[]
  branch: string | undefined
  headSha: string | undefined
}

export type StoreStatus = 'loading' | 'noRepo' | 'signedOut' | 'ready'

export type RepoLists = {
  categories: PrCategory[]
  /** Set when the last refresh failed. The categories keep their last data */
  error: string | undefined
}

export type StoreApi = Pick<
  GitHubApi,
  | 'fetchLists'
  | 'fetchBranchPrs'
  | 'fetchDetail'
  | 'fetchCommits'
  | 'fetchCommitsTouchingPath'
  | 'setFilesViewed'
  | 'addThread'
  | 'addThreadReply'
  | 'addReview'
  | 'submitReview'
  | 'deleteReview'
  | 'updateComment'
  | 'deleteComment'
  | 'setThreadResolved'
  | 'addIssueComment'
  | 'merge'
  | 'enableAutoMerge'
  | 'disableAutoMerge'
  | 'markReadyForReview'
  | 'fetchLabels'
  | 'fetchReviewerOptions'
  | 'addLabels'
  | 'removeLabels'
  | 'requestReviews'
  | 'removeReviewRequests'
>

export type StoreDeps = {
  api: StoreApi
  baselines: BaselineStore
  getQueries: () => ListQuery[]
  notify: (level: 'error' | 'warning', message: string) => void
  log: (message: string) => void
  now: () => number
  persistedFocus: {
    get: () => string | undefined
    set: (key: string | undefined) => void
  }
  /** Survives a restart, like the focus. What `get` returns is validated */
  persistedBranches: {
    get: () => unknown
    set: (records: BranchRecords) => void
  }
}

/**
 * The last branch of each repository whose pull request was looked up, and the
 * pull request that was found. A detached HEAD does not replace the record.
 */
const branchRecordsSchema = z.record(
  z.string(),
  z.object({ branch: z.string(), pr: z.string().optional() }),
)
export type BranchRecords = z.infer<typeof branchRecordsSchema>
type BranchRecord = BranchRecords[string]

export type CommentTarget =
  | {
      kind: 'thread'
      path: string
      /** Undefined for a comment on the whole file */
      line: number | undefined
      startLine: number | undefined
      side: DiffSide
    }
  | { kind: 'reply'; threadId: string }

type ViewedOverride = { state: ViewedState; token: object }

/**
 * The single source of truth for the pull requests. It keeps the last data
 * that was loaded while it refreshes, only announces a change when the data
 * really changed, and never lets an older response replace a newer one. The
 * views are a pure function of this state, which is what keeps them stable.
 */
export class PrStore {
  private readonly statusEmitter = new Emitter<void>()
  private readonly listsEmitter = new Emitter<void>()
  private readonly detailEmitter = new Emitter<string>()
  private readonly focusEmitter = new Emitter<void>()

  readonly onDidChangeStatus = this.statusEmitter.event
  readonly onDidChangeLists = this.listsEmitter.event
  /** Fires with the key of the pull request whose data changed */
  readonly onDidChangeDetail = this.detailEmitter.event
  readonly onDidChangeFocus = this.focusEmitter.event

  private gitReady = false
  private authFailed = false
  private repos: LocalRepo[] = []
  private viewerLogin: string | undefined

  private readonly lists = new Map<string, RepoLists>()
  private listsJson = ''
  private readonly checkedOut = new Map<string, PrSummary>()
  private readonly branchRecords: Map<string, BranchRecord>
  private branchRecordsJson: string

  private readonly details = new Map<string, PrDetail>()
  private readonly detailJson = new Map<string, string>()
  private readonly detailErrors = new Map<string, string>()
  private readonly detailTasks = new Map<string, SerialTask>()
  private readonly diffCaches = new Map<string, DiffCache>()
  private readonly headSeen = new Map<string, { head: string; at: number }>()
  private readonly overrides = new Map<string, Map<string, ViewedOverride>>()
  private readonly watchers = new Map<string, number>()

  private focused: string | undefined
  private readonly listsTask: SerialTask

  constructor(private readonly deps: StoreDeps) {
    this.focused = deps.persistedFocus.get()
    const records = branchRecordsSchema.safeParse(deps.persistedBranches.get())
    this.branchRecords = new Map(records.success ? Object.entries(records.data) : [])
    this.branchRecordsJson = JSON.stringify([...this.branchRecords])
    this.listsTask = new SerialTask(() => this.loadLists())
  }

  get status(): StoreStatus {
    if (!this.gitReady) return 'loading'
    if (this.repos.length === 0) return 'noRepo'
    if (this.authFailed) return 'signedOut'
    return 'ready'
  }

  get viewer(): string | undefined {
    return this.viewerLogin
  }

  /**
   * The pull request of the Changes view, which is always the one of the
   * current branch. With several repositories it is one of theirs.
   */
  get focusedKey(): string | undefined {
    return this.focused
  }

  /** True while the pull request of a branch that was just checked out is looked up */
  get isFindingBranchPr(): boolean {
    if (!this.gitReady) return true
    return this.repos.some(
      (repo) =>
        repo.branch !== undefined &&
        this.branchRecords.get(repo.rootPath)?.branch !== repo.branch &&
        this.lists.get(repo.rootPath)?.error === undefined,
    )
  }

  /** The pull requests of the current branches, as far as they are known */
  private branchPrKeys(): string[] {
    const keys: string[] = []
    for (const repo of this.repos) {
      const record = this.branchRecords.get(repo.rootPath)
      // a detached HEAD is usually a rebase, which comes back to the branch.
      // After a switch, the pull request of the new branch is not known yet.
      const isCurrent = repo.branch === undefined || record?.branch === repo.branch
      if (isCurrent && record?.pr !== undefined) keys.push(record.pr)
    }
    return keys
  }

  /** Moves the focus away from a pull request that is not the one of a current branch */
  private syncFocus(): void {
    const keys = this.branchPrKeys()
    if (this.focused !== undefined && keys.includes(this.focused)) return
    this.setFocus(keys[0])
  }

  getRepos(): readonly LocalRepo[] {
    return this.repos
  }

  getLists(rootPath: string): RepoLists | undefined {
    return this.lists.get(rootPath)
  }

  getCheckedOut(rootPath: string): PrSummary | undefined {
    return this.checkedOut.get(rootPath)
  }

  /** The local repository that has a remote for the repository of the pull request */
  getRepoForPr(key: string): LocalRepo | undefined {
    const ref = parsePrKey(key)
    if (!ref) return undefined
    const target = repoKey(ref).toLowerCase()
    return this.repos.find((repo) =>
      repo.remotes.some((remote) => repoKey(remote.repo).toLowerCase() === target),
    )
  }

  /** The local repository where the branch of this pull request is checked out */
  getCheckoutOf(key: string): LocalRepo | undefined {
    return this.repos.find((repo) => {
      const pr = this.checkedOut.get(repo.rootPath)
      return pr !== undefined && summaryKey(pr) === key
    })
  }

  getCheckedOutKeys(): string[] {
    return [...this.checkedOut.values()].map(summaryKey)
  }

  /** The loaded data of a pull request, with the changes that are being saved */
  getDetail(key: string): PrDetail | undefined {
    const detail = this.details.get(key)
    const overrides = this.overrides.get(key)
    if (!detail || !overrides || overrides.size === 0) return detail

    return {
      ...detail,
      files: detail.files.map((file): PrFile => {
        const override = overrides.get(file.path)
        return override ? { ...file, viewedState: override.state } : file
      }),
    }
  }

  getLoadedKeys(): string[] {
    return [...this.details.keys()]
  }

  getDetailError(key: string): string | undefined {
    return this.detailErrors.get(key)
  }

  getBaselines(key: string): BaselineMap {
    return this.deps.baselines.get(key)
  }

  /** Finds the summary of a pull request in what is loaded */
  findSummary(key: string): PrSummary | undefined {
    const detail = this.details.get(key)
    if (detail) return detail.summary
    for (const pr of this.checkedOut.values()) {
      if (summaryKey(pr) === key) return pr
    }
    for (const lists of this.lists.values()) {
      for (const category of lists.categories) {
        const pr = category.prs.find((item) => summaryKey(item) === key)
        if (pr) return pr
      }
    }
    return undefined
  }

  setRepos(repos: LocalRepo[]): void {
    const previous = new Map(this.repos.map((repo) => [repo.rootPath, repo]))
    const wasReady = this.gitReady
    this.gitReady = true
    this.repos = repos

    for (const rootPath of [...this.lists.keys()]) {
      if (!repos.some((repo) => repo.rootPath === rootPath)) {
        this.lists.delete(rootPath)
        this.checkedOut.delete(rootPath)
      }
    }
    for (const repo of repos) {
      const before = previous.get(repo.rootPath)
      if (before && before.branch !== repo.branch) this.checkedOut.delete(repo.rootPath)
    }

    // the pull request of a branch that was left is not shown anymore, also
    // when the branch was switched while the window was closed. Before git
    // finds the repositories, the focus of the last session is kept.
    if (repos.length > 0 || previous.size > 0) this.syncFocus()

    if (!wasReady || previous.size !== repos.length) this.statusEmitter.fire()
    this.listsEmitter.fire()
  }

  /**
   * Picks which pull request the Changes view shows when several repositories
   * have one for their branch. Other pull requests are ignored.
   */
  focus(key: string): void {
    if (this.branchPrKeys().includes(key)) this.setFocus(key)
  }

  private setFocus(key: string | undefined): void {
    if (this.focused === key) return
    this.focused = key
    this.deps.persistedFocus.set(key)
    this.focusEmitter.fire()
    if (key) void this.refreshDetail(key)
  }

  /** Keeps a pull request refreshed while something displays it */
  watch(key: string): Disposable {
    this.watchers.set(key, (this.watchers.get(key) ?? 0) + 1)
    if (!this.details.has(key)) void this.refreshDetail(key)
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        disposed = true
        const count = (this.watchers.get(key) ?? 1) - 1
        if (count <= 0) this.watchers.delete(key)
        else this.watchers.set(key, count)
      },
    }
  }

  private watchedKeys(): string[] {
    const keys = new Set<string>(this.watchers.keys())
    if (this.focused) keys.add(this.focused)
    for (const pr of this.checkedOut.values()) keys.add(summaryKey(pr))
    return [...keys]
  }

  async refreshAll(): Promise<void> {
    if (this.repos.length === 0) return
    await this.refreshLists()
    await Promise.all(this.watchedKeys().map((key) => this.refreshDetail(key)))
  }

  refreshLists(): Promise<void> {
    return this.listsTask.run()
  }

  refreshDetail(key: string): Promise<void> {
    let task = this.detailTasks.get(key)
    if (!task) {
      task = new SerialTask(() => this.loadDetail(key))
      this.detailTasks.set(key, task)
    }
    return task.run()
  }

  private setAuthFailed(failed: boolean): void {
    if (this.authFailed === failed) return
    this.authFailed = failed
    this.statusEmitter.fire()
  }

  private async findCheckedOut(repo: LocalRepo): Promise<PrSummary | undefined> {
    const branch = repo.branch
    if (!branch) return undefined

    const repos = new Map<string, RepoRef>()
    for (const remote of [{ repo: repo.github }, ...repo.remotes]) {
      repos.set(repoKey(remote.repo).toLowerCase(), remote.repo)
    }
    const owners = new Set([...repos.values()].map((r) => r.owner.toLowerCase()))

    const results = await Promise.all(
      [...repos.values()].map((target) => this.deps.api.fetchBranchPrs(target, branch)),
    )

    // a branch name alone is not enough: forks of other people can have a
    // branch with the same name
    const candidates = results
      .flat()
      .filter(
        (pr) =>
          pr.headRefName === branch &&
          (!pr.isCrossRepository ||
            (pr.headRepoOwner !== undefined &&
              owners.has(pr.headRepoOwner.toLowerCase()))),
      )

    const open = candidates.filter((pr) => pr.state === 'OPEN')
    return (
      open.find((pr) => pr.headRefOid === repo.headSha) ??
      open[0] ??
      candidates.find((pr) => pr.headRefOid === repo.headSha)
    )
  }

  private async loadLists(): Promise<void> {
    const repos = this.repos
    if (repos.length === 0) return
    const queries = this.deps.getQueries()
    const outcome = { authFailed: false, anySucceeded: false }
    /** The pull request of the branch that each repository had when the load started */
    const found = new Map<string, PrSummary | undefined>()

    await Promise.all(
      repos.map(async (repo) => {
        try {
          const [lists, byBranch] = await Promise.all([
            this.deps.api.fetchLists(repo.github, queries),
            this.findCheckedOut(repo),
          ])
          // the branch of a fork has another name locally, but the same commit
          const checkedOut =
            byBranch ??
            (repo.headSha === undefined ? undefined : (
              lists.categories
                .flatMap((category) => category.prs)
                .find((pr) => pr.headRefOid === repo.headSha)
            ))
          outcome.anySucceeded = true
          this.viewerLogin = lists.viewer
          this.lists.set(repo.rootPath, { categories: lists.categories, error: undefined })
          found.set(repo.rootPath, checkedOut)
        } catch (error) {
          if (error instanceof GitHubError && error.kind === 'auth') {
            outcome.authFailed = true
          }
          this.deps.log(`Failed to load the pull requests: ${errorMessage(error)}`)
          this.lists.set(repo.rootPath, {
            categories: this.lists.get(repo.rootPath)?.categories ?? [],
            error: errorMessage(error),
          })
        }
      }),
    )

    // the branch can change while the lists load. Then the pull request that
    // was found is the one of the branch that was left, and a failed load says
    // nothing about the branch
    const current: LocalRepo[] = []
    for (const loaded of repos) {
      if (!found.has(loaded.rootPath)) continue
      const repo = this.repos.find((item) => item.rootPath === loaded.rootPath)
      if (!repo || repo.branch !== loaded.branch) continue
      current.push(repo)
      const pr = found.get(repo.rootPath)
      if (pr) this.checkedOut.set(repo.rootPath, pr)
      else this.checkedOut.delete(repo.rootPath)
    }

    // the repositories can change while the lists load
    for (const rootPath of [...this.lists.keys()]) {
      if (!this.repos.some((repo) => repo.rootPath === rootPath)) {
        this.lists.delete(rootPath)
        this.checkedOut.delete(rootPath)
      }
    }

    if (outcome.authFailed) this.setAuthFailed(true)
    else if (outcome.anySucceeded) this.setAuthFailed(false)

    // the focus follows the branch
    let switchedTo: string | undefined
    for (const repo of current) {
      if (repo.branch === undefined) continue
      const pr = this.checkedOut.get(repo.rootPath)
      const key = pr ? summaryKey(pr) : undefined
      const before = this.branchRecords.get(repo.rootPath)
      if (before && before.branch !== repo.branch && key !== undefined) switchedTo = key
      this.branchRecords.set(repo.rootPath, { branch: repo.branch, pr: key })
    }

    const recordsJson = JSON.stringify([...this.branchRecords])
    if (recordsJson !== this.branchRecordsJson) {
      this.branchRecordsJson = recordsJson
      this.deps.persistedBranches.set(Object.fromEntries(this.branchRecords))
    }

    const json = JSON.stringify([[...this.lists], [...this.checkedOut], recordsJson])
    if (json !== this.listsJson) {
      this.listsJson = json
      this.listsEmitter.fire()
    }

    // with several repositories, the one whose branch was switched wins
    if (switchedTo !== undefined) this.setFocus(switchedTo)
    else this.syncFocus()
  }

  private async loadDetail(key: string): Promise<void> {
    const ref = parsePrKey(key)
    if (!ref) return

    try {
      const { detail, cache } = await this.deps.api.fetchDetail(
        ref,
        this.diffCaches.get(key),
      )
      this.diffCaches.set(key, cache)
      this.setAuthFailed(false)
      this.applyDetail(key, detail)
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'auth') this.setAuthFailed(true)
      const message = errorMessage(error)
      this.deps.log(`Failed to load ${key}: ${message}`)
      if (this.detailErrors.get(key) !== message) {
        this.detailErrors.set(key, message)
        this.detailEmitter.fire(key)
      }
    }
  }

  private applyDetail(key: string, detail: PrDetail): void {
    const now = this.deps.now()
    const head = detail.summary.headRefOid

    let seen = this.headSeen.get(key)
    if (seen?.head !== head) {
      seen = { head, at: now }
      this.headSeen.set(key, seen)
    }

    const baselines = reconcileBaselines({
      current: this.deps.baselines.get(key),
      files: detail.files,
      headSha: head,
      headFirstSeenAt: seen.at,
      now,
    })
    if (baselines.changed) this.deps.baselines.set(key, baselines.next, now)

    const hadError = this.detailErrors.delete(key)
    const json = JSON.stringify(detail)
    if (json === this.detailJson.get(key) && !baselines.changed && !hadError) return

    this.detailJson.set(key, json)
    this.details.set(key, detail)
    this.detailEmitter.fire(key)
  }

  private requireDetail(key: string): PrDetail {
    const detail = this.details.get(key)
    if (!detail) throw new Error('The pull request is not loaded yet')
    return detail
  }

  /**
   * Marks or unmarks files as viewed. The change shows at once and is undone
   * if GitHub rejects it. The version that was viewed is recorded, so that
   * later changes to the file can be shown on their own.
   */
  async setViewed(key: string, paths: readonly string[], viewed: boolean): Promise<void> {
    const current = this.getDetail(key)
    if (!current) return

    const wanted = new Set(paths)
    const targets = current.files.filter(
      (file) => wanted.has(file.path) && (file.viewedState === 'VIEWED') !== viewed,
    )
    if (targets.length === 0) return

    const token = {}
    let overrides = this.overrides.get(key)
    if (!overrides) {
      overrides = new Map()
      this.overrides.set(key, overrides)
    }
    for (const file of targets) {
      overrides.set(file.path, { state: viewed ? 'VIEWED' : 'UNVIEWED', token })
    }
    this.detailEmitter.fire(key)

    const targetPaths = targets.map((file) => file.path)
    const snapshotHead = current.summary.headRefOid
    const marked = targets.map((file) => ({ path: file.path, blob: headBlobId(file) }))

    try {
      const headAfter = await this.deps.api.setFilesViewed(
        current.summary.id,
        targetPaths,
        viewed,
      )

      const now = this.deps.now()
      const baselines = this.deps.baselines.get(key)
      this.deps.baselines.set(
        key,
        viewed ?
          markViewedBaselines(baselines, marked, snapshotHead, now)
        : removeBaselines(baselines, targetPaths),
        now,
      )

      await this.refreshDetail(key)

      if (viewed && headAfter !== undefined && headAfter !== snapshotHead) {
        await this.undoViewedOfChangedFiles(key, marked)
      }
    } catch (error) {
      this.deps.notify(
        'error',
        `Could not mark the ${targetPaths.length === 1 ? 'file' : 'files'} as ${viewed ? 'viewed' : 'not viewed'}: ${errorMessage(error)}`,
      )
      void this.refreshDetail(key)
    } finally {
      for (const path of targetPaths) {
        if (overrides.get(path)?.token === token) overrides.delete(path)
      }
      this.detailEmitter.fire(key)
    }
  }

  /**
   * A push can land between the moment the user looks at a file and the
   * moment GitHub marks it as viewed. GitHub then marks the new version,
   * which the user never saw. Those files are put back as not viewed and keep
   * the baseline of the version that was seen.
   */
  private async undoViewedOfChangedFiles(
    key: string,
    marked: readonly { path: string; blob: string | undefined }[],
  ): Promise<void> {
    const fresh = this.details.get(key)
    if (!fresh) return
    const byPath = new Map(fresh.files.map((file) => [file.path, file]))

    const changed = marked
      .filter((item) => {
        const file = byPath.get(item.path)
        return file !== undefined && headBlobId(file) !== item.blob
      })
      .map((item) => item.path)
    if (changed.length === 0) return

    await this.deps.api.setFilesViewed(fresh.summary.id, changed, false)
    await this.refreshDetail(key)
    this.deps.notify(
      'warning',
      changed.length === 1 ?
        `${changed[0]} changed while it was marked as viewed, so it was left as not viewed.`
      : `${changed.length} files changed while they were marked as viewed, so they were left as not viewed.`,
    )
  }

  /**
   * Adds a review comment. A single comment is published right away. A review
   * comment stays pending until the review is submitted. GitHub does not allow
   * single comments while a review is pending, so they join the review.
   */
  async addComment(
    key: string,
    target: CommentTarget,
    body: string,
    mode: 'single' | 'review',
  ): Promise<void> {
    const detail = this.requireDetail(key)
    const pending = detail.pendingReview

    const result =
      target.kind === 'thread' ?
        await this.deps.api.addThread({
          pullRequestId: detail.summary.id,
          pullRequestReviewId: pending?.id,
          path: target.path,
          body,
          line: target.line,
          startLine: target.startLine,
          side: target.side,
        })
      : await this.deps.api.addThreadReply({
          threadId: target.threadId,
          pullRequestReviewId: pending?.id,
          body,
        })

    // without a pending review GitHub starts one for the comment
    const review = result?.pullRequestReview
    if (mode === 'single' && !pending && review?.state === 'PENDING') {
      await this.deps.api.submitReview({
        pullRequestReviewId: review.id,
        event: 'COMMENT',
        body: undefined,
      })
    }

    await this.refreshDetail(key)
  }

  async submitReview(key: string, event: ReviewEvent, body: string): Promise<void> {
    const detail = this.requireDetail(key)
    const text = body.trim() === '' ? undefined : body

    if (detail.pendingReview) {
      await this.deps.api.submitReview({
        pullRequestReviewId: detail.pendingReview.id,
        event,
        body: text,
      })
    } else {
      await this.deps.api.addReview({
        pullRequestId: detail.summary.id,
        event,
        body: text,
      })
    }
    await Promise.all([this.refreshDetail(key), this.refreshLists()])
  }

  async discardReview(key: string): Promise<void> {
    const detail = this.requireDetail(key)
    if (!detail.pendingReview) return
    await this.deps.api.deleteReview(detail.pendingReview.id)
    await this.refreshDetail(key)
  }

  async editComment(key: string, commentId: string, body: string): Promise<void> {
    await this.deps.api.updateComment(commentId, body)
    await this.refreshDetail(key)
  }

  async deleteComment(key: string, commentId: string): Promise<void> {
    await this.deps.api.deleteComment(commentId)
    await this.refreshDetail(key)
  }

  async setThreadResolved(key: string, threadId: string, resolved: boolean): Promise<void> {
    await this.deps.api.setThreadResolved(threadId, resolved)
    await this.refreshDetail(key)
  }

  async addIssueComment(key: string, body: string): Promise<void> {
    const detail = this.requireDetail(key)
    await this.deps.api.addIssueComment(detail.summary.id, body)
    await this.refreshDetail(key)
  }

  async merge(key: string, mergeMethod: MergeMethod): Promise<void> {
    const detail = this.requireDetail(key)
    await this.deps.api.merge({
      pullRequestId: detail.summary.id,
      mergeMethod,
      expectedHeadOid: detail.summary.headRefOid,
    })
    await Promise.all([this.refreshDetail(key), this.refreshLists()])
  }

  /** The pull request can merge at once, when it already meets its requirements */
  async enableAutoMerge(key: string, mergeMethod: MergeMethod): Promise<void> {
    const detail = this.requireDetail(key)
    await this.deps.api.enableAutoMerge({
      pullRequestId: detail.summary.id,
      mergeMethod,
      expectedHeadOid: detail.summary.headRefOid,
    })
    await Promise.all([this.refreshDetail(key), this.refreshLists()])
  }

  async disableAutoMerge(key: string): Promise<void> {
    const detail = this.requireDetail(key)
    await this.deps.api.disableAutoMerge(detail.summary.id)
    await this.refreshDetail(key)
  }

  async markReadyForReview(key: string): Promise<void> {
    const detail = this.requireDetail(key)
    await this.deps.api.markReadyForReview(detail.summary.id)
    await Promise.all([this.refreshDetail(key), this.refreshLists()])
  }

  /** The labels of the repository of a pull request */
  async fetchLabelOptions(key: string): Promise<LabelOption[]> {
    const ref = parsePrKey(key)
    return ref ? this.deps.api.fetchLabels(ref) : []
  }

  /** The users and the teams that can review a pull request */
  async fetchReviewerOptions(key: string): Promise<ReviewerOption[]> {
    const ref = parsePrKey(key)
    return ref ? this.deps.api.fetchReviewerOptions(ref) : []
  }

  async updateLabels(key: string, change: LabelChange): Promise<void> {
    const { id } = this.requireDetail(key).summary
    try {
      if (change.add.length > 0) await this.deps.api.addLabels(id, change.add)
      if (change.remove.length > 0) await this.deps.api.removeLabels(id, change.remove)
    } finally {
      // one of the two changes can be saved when the other one fails
      await this.refreshDetail(key)
    }
  }

  async updateReviewers(key: string, change: ReviewerChange): Promise<void> {
    const { id } = this.requireDetail(key).summary
    const ref = parsePrKey(key)
    if (!ref) return
    const { add, remove } = change

    try {
      if (add.userIds.length > 0 || add.teamIds.length > 0) {
        await this.deps.api.requestReviews({ pullRequestId: id, ...add })
      }
      if (remove.logins.length > 0 || remove.teamSlugs.length > 0) {
        await this.deps.api.removeReviewRequests(ref, remove)
      }
    } finally {
      // the lists can have a category for the reviews that are requested
      await Promise.all([this.refreshDetail(key), this.refreshLists()])
    }
  }

  /** The commits of the pull request that changed a file, newest first */
  async fetchCommitsOfFile(key: string, path: string): Promise<PrCommit[]> {
    const detail = this.requireDetail(key)
    const ref = parsePrKey(key)
    if (!ref) return []

    const [commits, touching] = await Promise.all([
      this.deps.api.fetchCommits(ref),
      this.deps.api.fetchCommitsTouchingPath(ref, detail.summary.headRefOid, path),
    ])
    const touchingSet = new Set(touching)
    return commits.filter((commit) => touchingSet.has(commit.oid)).reverse()
  }

  dispose(): void {
    this.statusEmitter.dispose()
    this.listsEmitter.dispose()
    this.detailEmitter.dispose()
    this.focusEmitter.dispose()
  }
}
