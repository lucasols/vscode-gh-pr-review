import * as vscode from 'vscode'
import { z } from 'zod'
import type { ListQuery } from './github/api'
import type { NonRelevantChangeKind } from './model/changeClassifier'
import { repoKey, type RepoRef } from './util/remoteUrl'
import { reviewersOf } from './util/repoReviewers'
import { namesOf, withNames, type RepoSetting } from './util/repoSetting'

const SECTION = 'ghPrReview'

export const AUTO_MARK_SETTING = 'autoMarkNonRelevantChangesAsViewed'

const queriesSchema = z.array(z.object({ label: z.string(), query: z.string() }))
const autoMarkSchema = z.array(z.enum(['lockfile', 'renameOnly', 'importsOnly']))
const repoSettingSchema = z.record(z.string(), z.array(z.string()))

const DEFAULT_QUERIES: ListQuery[] = [
  { label: 'Waiting For My Review', query: 'is:open review-requested:@me' },
  { label: 'Created By Me', query: 'is:open author:@me' },
  { label: 'All Open', query: 'is:open' },
]

function get(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION)
}

type RepoSettingName = 'reviewers' | 'quickAddLabels'

function repoSetting(name: RepoSettingName): RepoSetting {
  const parsed = repoSettingSchema.safeParse(get().get(name))
  return parsed.success ? parsed.data : {}
}

/** These settings belong to the user, so they are the same in every clone of a repository */
function setRepoSetting(
  name: RepoSettingName,
  repo: RepoRef,
  names: readonly string[],
): Thenable<void> {
  return get().update(
    name,
    withNames(repoSetting(name), repoKey(repo), names),
    vscode.ConfigurationTarget.Global,
  )
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
    return reviewersOf(repoSetting('reviewers'), repoKey(repo))
  },

  setReviewers(repo: RepoRef, reviewers: readonly string[]): Thenable<void> {
    return setRepoSetting('reviewers', repo, reviewers)
  },

  /** The names of the labels that the overview adds with one click in a repository */
  quickAddLabels(repo: RepoRef): string[] {
    return namesOf(repoSetting('quickAddLabels'), repoKey(repo))
  },

  setQuickAddLabels(repo: RepoRef, labels: readonly string[]): Thenable<void> {
    return setRepoSetting('quickAddLabels', repo, labels)
  },

  affects(event: vscode.ConfigurationChangeEvent, name: string): boolean {
    return event.affectsConfiguration(`${SECTION}.${name}`)
  },
}
