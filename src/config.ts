import * as vscode from 'vscode'
import { z } from 'zod'
import type { ListQuery } from './github/api'
import type { NonRelevantChangeKind } from './model/changeClassifier'
import { reviewersOf, withReviewers } from './util/repoReviewers'
import { repoKey, type RepoRef } from './util/remoteUrl'

const SECTION = 'ghPrReview'

export const AUTO_MARK_SETTING = 'autoMarkNonRelevantChangesAsViewed'

const queriesSchema = z.array(z.object({ label: z.string(), query: z.string() }))
const autoMarkSchema = z.array(z.enum(['lockfile', 'renameOnly', 'importsOnly']))
const reviewersSchema = z.record(z.string(), z.array(z.string()))

const DEFAULT_QUERIES: ListQuery[] = [
  { label: 'Waiting For My Review', query: 'is:open review-requested:@me' },
  { label: 'Created By Me', query: 'is:open author:@me' },
  { label: 'All Open', query: 'is:open' },
]

function get(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION)
}

export const config = {
  queries(): ListQuery[] {
    const parsed = queriesSchema.safeParse(get().get('queries'))
    return parsed.success ? parsed.data : DEFAULT_QUERIES
  },

  refreshIntervalMs(): number {
    const seconds = get().get('refreshIntervalSeconds')
    return Math.max(15, typeof seconds === 'number' ? seconds : 60) * 1000
  },

  fileLayout(): 'tree' | 'list' {
    return get().get('fileLayout') === 'list' ? 'list' : 'tree'
  },

  setFileLayout(layout: 'tree' | 'list'): Thenable<void> {
    return get().update('fileLayout', layout, vscode.ConfigurationTarget.Global)
  },

  hideViewedFiles(): boolean {
    return get().get('hideViewedFiles') === true
  },

  setHideViewedFiles(hide: boolean): Thenable<void> {
    return get().update('hideViewedFiles', hide, vscode.ConfigurationTarget.Global)
  },

  defaultDiff(): 'sinceViewed' | 'full' {
    return get().get('defaultDiff') === 'full' ? 'full' : 'sinceViewed'
  },

  useLocalFiles(): boolean {
    return get().get('useLocalFiles') !== false
  },

  /** The kinds of non-relevant changes that are marked as viewed automatically */
  autoMarkKinds(): NonRelevantChangeKind[] {
    const parsed = autoMarkSchema.safeParse(get().get(AUTO_MARK_SETTING))
    return parsed.success ? parsed.data : []
  },

  /**
   * Who is offered as a reviewer in a repository: logins and slugs of teams,
   * in lower case. Undefined when everyone is offered.
   */
  reviewers(repo: RepoRef): Set<string> | undefined {
    const parsed = reviewersSchema.safeParse(get().get('reviewers'))
    return reviewersOf(parsed.success ? parsed.data : {}, repoKey(repo))
  },

  /** The setting belongs to the user, so it is the same in every clone of a repository */
  setReviewers(repo: RepoRef, reviewers: readonly string[]): Thenable<void> {
    const parsed = reviewersSchema.safeParse(get().get('reviewers'))
    return get().update(
      'reviewers',
      withReviewers(parsed.success ? parsed.data : {}, repoKey(repo), reviewers),
      vscode.ConfigurationTarget.Global,
    )
  },

  affects(event: vscode.ConfigurationChangeEvent, name: string): boolean {
    return event.affectsConfiguration(`${SECTION}.${name}`)
  },
}
