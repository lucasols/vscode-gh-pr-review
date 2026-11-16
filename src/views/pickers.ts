import * as vscode from 'vscode'
import type { LabelChange, Reviewer, ReviewerChange } from '../model/types'
import type { Services } from '../services'
import { errorMessage } from '../util/async'

/**
 * Shows a picker of several items right away and fills it when the items are
 * loaded. Returns the items that are checked, or undefined when it is closed.
 */
function pickMany<T extends vscode.QuickPickItem>(options: {
  title: string
  placeholder: string
  failure: string
  load: () => Promise<T[]>
}): Promise<readonly T[] | undefined> {
  const quickPick = vscode.window.createQuickPick<T>()
  quickPick.title = options.title
  quickPick.placeholder = 'Loading…'
  quickPick.canSelectMany = true
  quickPick.matchOnDescription = true
  quickPick.busy = true
  quickPick.show()

  return new Promise((resolve) => {
    let isLoaded = false
    let isDone = false
    const finish = (picked: readonly T[] | undefined) => {
      if (isDone) return
      isDone = true
      resolve(picked)
      quickPick.dispose()
    }

    quickPick.onDidAccept(() => {
      if (isLoaded) finish(quickPick.selectedItems)
    })
    quickPick.onDidHide(() => finish(undefined))

    void options.load().then(
      (items) => {
        if (isDone) return
        quickPick.items = items
        quickPick.selectedItems = items.filter((item) => item.picked)
        quickPick.placeholder = options.placeholder
        quickPick.busy = false
        isLoaded = true
      },
      (error: unknown) => {
        void vscode.window.showErrorMessage(`${options.failure}: ${errorMessage(error)}`)
        finish(undefined)
      },
    )
  })
}

/** The checked items first, in the order that they already have */
function checkedFirst<T extends vscode.QuickPickItem>(items: readonly T[]): T[] {
  return [...items.filter((item) => item.picked), ...items.filter((item) => !item.picked)]
}

function prNumber(prKey: string): string {
  return prKey.slice(prKey.lastIndexOf('#') + 1)
}

/** A dot with the color of a label, as the icon of its item */
function labelIcon(color: string): vscode.Uri | undefined {
  if (!/^[0-9a-f]{6}$/i.test(color)) return undefined
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#${color}"/></svg>`
  return vscode.Uri.parse(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  )
}

type LabelItem = vscode.QuickPickItem & { id: string }

/** Asks which labels the pull request should have. Undefined when nothing changes */
export async function pickLabels(
  services: Services,
  prKey: string,
): Promise<LabelChange | undefined> {
  const { store } = services
  let current = new Set<string>()

  const picked = await pickMany<LabelItem>({
    title: `Labels of #${prNumber(prKey)}`,
    placeholder: 'Check the labels of the pull request',
    failure: 'Could not load the labels',
    load: async () => {
      const options = await store.fetchLabelOptions(prKey)
      // read after the options, so that the checked labels are the latest known
      const labels = store.getDetail(prKey)?.overview.labels ?? []
      current = new Set(labels.map((label) => label.id))

      const listed = new Set(options.map((option) => option.id))
      const all = [
        ...options,
        ...labels
          .filter((label) => !listed.has(label.id))
          .map((label) => ({ ...label, description: undefined })),
      ]
      return checkedFirst(
        all.map((label) => ({
          id: label.id,
          label: label.name,
          description: label.description,
          iconPath: labelIcon(label.color),
          picked: current.has(label.id),
        })),
      )
    },
  })
  if (!picked) return undefined

  const wanted = new Set(picked.map((item) => item.id))
  const change: LabelChange = {
    add: [...wanted].filter((id) => !current.has(id)),
    remove: [...current].filter((id) => !wanted.has(id)),
  }
  return change.add.length + change.remove.length === 0 ? undefined : change
}

const REVIEWER_STATE_TEXT: Record<Reviewer['state'], string> = {
  REQUESTED: 'Review requested',
  APPROVED: 'Approved, check to request again',
  CHANGES_REQUESTED: 'Requested changes, check to request again',
  COMMENTED: 'Commented, check to request again',
  DISMISSED: 'Review dismissed, check to request again',
}

type ReviewerRef = { kind: Reviewer['kind']; slug: string }

type ReviewerItem = vscode.QuickPickItem & {
  reviewer: ReviewerRef & {
    /** GraphQL node id. Not known for a request to someone that is not listed */
    id: string | undefined
  }
}

function reviewerKey(reviewer: ReviewerRef): string {
  return `${reviewer.kind}:${reviewer.slug.toLowerCase()}`
}

function reviewerIcon(
  kind: Reviewer['kind'],
  avatarUrl: string | undefined,
): vscode.Uri | vscode.ThemeIcon {
  if (avatarUrl) return vscode.Uri.parse(avatarUrl)
  return new vscode.ThemeIcon(kind === 'team' ? 'organization' : 'account')
}

/**
 * Asks who should review the pull request. The checked ones are who has a
 * request for a review. Undefined when nothing changes.
 */
export async function pickReviewers(
  services: Services,
  prKey: string,
): Promise<ReviewerChange | undefined> {
  const { store } = services
  let requested: ReviewerItem[] = []

  const picked = await pickMany<ReviewerItem>({
    title: `Reviewers of #${prNumber(prKey)}`,
    placeholder: 'Check who should review the pull request',
    failure: 'Could not load the reviewers',
    load: async () => {
      const options = await store.fetchReviewerOptions(prKey)
      // read after the options, so that the checked reviewers are the latest known
      const detail = store.getDetail(prKey)
      const author = detail?.summary.author?.login.toLowerCase()
      const reviewers = new Map(
        (detail?.overview.reviewers ?? []).map((reviewer) => [
          reviewerKey(reviewer),
          reviewer,
        ]),
      )

      const reviewed: ReviewerItem[] = []
      const others: ReviewerItem[] = []
      const listed = new Set<string>()

      for (const option of options) {
        // the author of a pull request cannot review it
        if (option.kind === 'user' && option.slug.toLowerCase() === author) continue
        const key = reviewerKey(option)
        const reviewer = reviewers.get(key)
        listed.add(key)
        ;(reviewer ? reviewed : others).push({
          reviewer: { kind: option.kind, slug: option.slug, id: option.id },
          label: option.kind === 'team' ? (option.name ?? option.slug) : option.slug,
          description: [
            option.kind === 'team' ? 'Team' : option.name,
            reviewer && REVIEWER_STATE_TEXT[reviewer.state],
          ]
            .filter(Boolean)
            .join(' · '),
          iconPath: reviewerIcon(option.kind, option.avatarUrl),
          picked: reviewer?.state === 'REQUESTED',
        })
      }

      // a request can be for someone that is not listed, like a bot. It is
      // shown so that it can be removed
      for (const [key, reviewer] of reviewers) {
        if (listed.has(key) || reviewer.state !== 'REQUESTED') continue
        reviewed.push({
          reviewer: { kind: reviewer.kind, slug: reviewer.slug, id: undefined },
          label: reviewer.name,
          description: REVIEWER_STATE_TEXT.REQUESTED,
          iconPath: reviewerIcon(reviewer.kind, reviewer.avatarUrl),
          picked: true,
        })
      }

      const items = checkedFirst([...reviewed, ...others])
      requested = items.filter((item) => item.picked)
      return items
    },
  })
  if (!picked) return undefined

  const change: ReviewerChange = {
    add: { userIds: [], teamIds: [] },
    remove: { logins: [], teamSlugs: [] },
  }
  const requestedKeys = new Set(requested.map((item) => reviewerKey(item.reviewer)))
  const pickedKeys = new Set(picked.map((item) => reviewerKey(item.reviewer)))

  for (const { reviewer } of picked) {
    if (reviewer.id === undefined || requestedKeys.has(reviewerKey(reviewer))) continue
    if (reviewer.kind === 'team') change.add.teamIds.push(reviewer.id)
    else change.add.userIds.push(reviewer.id)
  }
  for (const { reviewer } of requested) {
    if (pickedKeys.has(reviewerKey(reviewer))) continue
    if (reviewer.kind === 'team') change.remove.teamSlugs.push(reviewer.slug)
    else change.remove.logins.push(reviewer.slug)
  }

  const count =
    change.add.userIds.length +
    change.add.teamIds.length +
    change.remove.logins.length +
    change.remove.teamSlugs.length
  return count === 0 ? undefined : change
}
