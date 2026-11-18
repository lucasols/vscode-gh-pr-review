import { config } from '../config'
import { labelsToOffer, reviewersToOffer } from '../model/quickAdd'
import type { PrStore } from '../model/prStore'
import {
  parsePrKey,
  type LabelOption,
  type PrDetail,
  type ReviewerChange,
  type ReviewerOption,
} from '../model/types'
import type { OverviewEditField, OverviewQuickAddOption } from '../shared/overviewProtocol'
import { repoKey, type RepoRef } from '../util/remoteUrl'

/**
 * What a repository offers, loaded once and kept. `get` answers at once with
 * what is known, and `onLoaded` tells when the options arrive.
 */
class RepoOptions<T> {
  private readonly loaded = new Map<string, T[]>()
  private readonly requested = new Set<string>()

  constructor(
    private readonly fetch: (repo: RepoRef) => Promise<T[]>,
    private readonly onLoaded: () => void,
  ) {}

  get(repo: RepoRef): T[] | undefined {
    const key = repoKey(repo).toLowerCase()
    if (!this.requested.has(key)) {
      this.requested.add(key)
      void this.fetch(repo).then(
        (options) => {
          this.loaded.set(key, options)
          this.onLoaded()
        },
        // not tried again until `reload`: the buttons are a shortcut, and the
        // dropdown still shows why the options cannot be loaded
        () => undefined,
      )
    }
    return this.loaded.get(key)
  }

  /** The next `get` loads the options again, and answers with the old ones meanwhile */
  reload(repo: RepoRef): void {
    this.requested.delete(repoKey(repo).toLowerCase())
  }
}

/**
 * The buttons of the overview that add a reviewer or a label with one click.
 * The reviewers are the ones that the user picked for the repository
 * (`ghPrReview.reviewers`), and the labels are the ones of
 * `ghPrReview.quickAddLabels`.
 */
export class QuickAdd {
  private readonly reviewerOptions: RepoOptions<ReviewerOption>
  private readonly labelOptions: RepoOptions<LabelOption>

  constructor(
    private readonly store: PrStore,
    /** The options of a repository arrived, so there can be buttons to show */
    onLoaded: () => void,
  ) {
    this.reviewerOptions = new RepoOptions((repo) => store.fetchReviewerOptions(repo), onLoaded)
    this.labelOptions = new RepoOptions((repo) => store.fetchLabelOptions(repo), onLoaded)
  }

  private reviewers(prKey: string, detail: PrDetail): ReviewerOption[] {
    const repo = parsePrKey(prKey)
    const { summary, overview } = detail
    if (!repo || !overview.viewerCanRequestReviews || summary.state !== 'OPEN') return []
    const offered = config.reviewers(repo)
    if (!offered) return []
    return reviewersToOffer({
      offered,
      options: this.reviewerOptions.get(repo) ?? [],
      reviewers: overview.reviewers,
      author: summary.author?.login,
    })
  }

  private labels(prKey: string, detail: PrDetail): LabelOption[] {
    const repo = parsePrKey(prKey)
    if (!repo || !detail.overview.viewerCanLabel) return []
    const names = config.quickAddLabels(repo)
    if (names.length === 0) return []
    return labelsToOffer({
      names,
      options: this.labelOptions.get(repo) ?? [],
      labels: detail.overview.labels,
    })
  }

  /** What the page shows a button for. The key of a button is the id of its option */
  options(
    prKey: string,
    detail: PrDetail,
  ): { reviewers: OverviewQuickAddOption[]; labels: OverviewQuickAddOption[] } {
    return {
      reviewers: this.reviewers(prKey, detail).map((option) => ({
        key: option.id,
        label: option.kind === 'team' ? (option.name ?? option.slug) : option.slug,
        description: option.kind === 'team' ? 'Team' : option.name,
        avatarUrl: option.avatarUrl,
      })),
      labels: this.labels(prKey, detail).map((option) => ({
        key: option.id,
        label: option.name,
        description: option.description,
        color: option.color,
      })),
    }
  }

  /**
   * What adds the options of the buttons that were clicked. Undefined when
   * none of them can be added anymore, as the page can be older than the store.
   */
  save(
    prKey: string,
    field: OverviewEditField,
    keys: readonly string[],
  ): (() => Promise<void>) | undefined {
    const { store } = this
    const detail = store.getDetail(prKey)
    if (!detail) return undefined
    const clicked = new Set(keys)

    if (field === 'labels') {
      const add = this.labels(prKey, detail)
        .filter((option) => clicked.has(option.id))
        .map((option) => option.id)
      if (add.length === 0) return undefined
      return () => store.updateLabels(prKey, { add, remove: [] })
    }

    const change: ReviewerChange = {
      add: { userIds: [], teamIds: [] },
      remove: { logins: [], teamSlugs: [] },
    }
    for (const option of this.reviewers(prKey, detail)) {
      if (!clicked.has(option.id)) continue
      if (option.kind === 'team') change.add.teamIds.push(option.id)
      else change.add.userIds.push(option.id)
    }
    if (change.add.userIds.length + change.add.teamIds.length === 0) return undefined
    return () => store.updateReviewers(prKey, change)
  }

  /** The reviewers and the labels of the repository are loaded again when they are needed */
  reload(prKey: string): void {
    const repo = parsePrKey(prKey)
    if (!repo) return
    this.reviewerOptions.reload(repo)
    this.labelOptions.reload(repo)
  }
}
