import { join } from 'node:path'
import * as vscode from 'vscode'
import { config } from '../config'
import {
  baseDocRef,
  commitDocRef,
  headDocRef,
  reviewedDocRef,
  viewedDocRef,
  type DocRef,
} from '../content/docRef'
import { toDocUri } from '../content/ghprFs'
import { isChangedSinceViewed, type Baseline } from '../model/baselines'
import type { PrDetail, PrFile } from '../model/types'
import type { Services } from '../services'
import { gitBlobSha } from '../util/gitBlobHash'

export type DiffMode = 'auto' | 'full' | 'sinceViewed'

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The file of the workspace for a file of the pull request, if there is a clone */
export function getLocalFileUri(
  services: Services,
  prKey: string,
  path: string,
): vscode.Uri | undefined {
  const repo = services.store.getRepoForPr(prKey)
  return repo ? vscode.Uri.file(join(repo.rootPath, path)) : undefined
}

/**
 * The document for the head version of a file. The file of the workspace is
 * used when its content is exactly the content of the pull request: it can be
 * edited and has language features, and its lines match the pull request.
 */
export async function resolveHeadUri(
  services: Services,
  prKey: string,
  detail: PrDetail,
  file: PrFile,
): Promise<vscode.Uri> {
  if (config.useLocalFiles() && file.blobSha && file.status !== 'removed') {
    const local = getLocalFileUri(services, prKey, file.path)
    if (local) {
      try {
        const bytes = await vscode.workspace.fs.readFile(local)
        if (gitBlobSha(bytes) === file.blobSha) return local
      } catch {
        // the file does not exist in the workspace
      }
    }
  }
  return toDocUri(headDocRef(detail, file))
}

async function loadFile(
  services: Services,
  prKey: string,
  path: string,
): Promise<{ detail: PrDetail; file: PrFile } | undefined> {
  if (!services.store.getDetail(prKey)) await services.store.refreshDetail(prKey)
  const detail = services.store.getDetail(prKey)
  if (!detail) {
    void vscode.window.showErrorMessage(
      services.store.getDetailError(prKey) ?? 'The pull request could not be loaded.',
    )
    return undefined
  }
  const file = detail.files.find((item) => item.path === path)
  if (!file) {
    void vscode.window.showWarningMessage(`${path} is not part of the pull request anymore.`)
    return undefined
  }
  return { detail, file }
}

/** Whether the left side of a diff is the version of the file that was viewed */
function showsSinceViewed(
  mode: DiffMode,
  file: PrFile,
  baseline: Baseline | undefined,
): baseline is Baseline {
  if (!baseline) return false
  if (mode === 'sinceViewed') return true
  return (
    mode === 'auto' &&
    config.defaultDiff() === 'sinceViewed' &&
    isChangedSinceViewed(file, baseline)
  )
}

/**
 * The left side of the diff of a file. The default diff of a file that is not
 * viewed compares with the reviewed version, which hides the lines that were
 * reviewed, like staged lines. It starts from the same version as the diff
 * would without it.
 */
function leftOf(
  mode: DiffMode,
  detail: PrDetail,
  file: PrFile,
  baseline: Baseline | undefined,
): { ref: DocRef; sinceViewed: boolean } {
  const sinceViewed = showsSinceViewed(mode, file, baseline)
  const reviewable =
    file.viewedState !== 'VIEWED' && file.status !== 'removed' && file.blobSha !== undefined
  // the reviewed version starts from the version of the default diff
  const startsTheSame =
    mode === 'auto' ||
    (mode === 'sinceViewed' && showsSinceViewed('auto', file, baseline))

  if (reviewable && startsTheSame) return { ref: reviewedDocRef(detail, file), sinceViewed }
  if (sinceViewed) return { ref: viewedDocRef(detail, file, baseline), sinceViewed }
  return { ref: baseDocRef(detail, file), sinceViewed }
}

// VS Code appends the number of files to the title of the tab
const STACKED_TITLE = /^(?:All|Unviewed) Changes in (.+?)(?: \([^()]*\))?$/

/**
 * Opens the diffs of the given files stacked in one editor. Each file is
 * compared like a click on it does: a file that changed after it was viewed
 * shows only the changes made since then.
 */
export async function openStackedChanges(
  services: Services,
  prKey: string,
  files: readonly PrFile[],
  options: { onlyUnviewed: boolean; folder?: string },
): Promise<void> {
  const detail = services.store.getDetail(prKey)
  if (!detail) return
  const { number } = detail.summary
  const scope =
    options.folder === undefined ? `#${number}` : `#${number} › ${options.folder}`

  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      detail.files.length > 0 ?
        `All files of ${scope} are viewed.`
      : `#${number} has no changed files.`,
    )
    return
  }

  const baselines = services.store.getBaselines(prKey)
  const resources = await Promise.all(
    files.map(async (file) => {
      const left = toDocUri(leftOf('auto', detail, file, baselines[file.path]).ref)
      const right = await resolveHeadUri(services, prKey, detail, file)
      return [right, left, right] as const
    }),
  )

  // the editor is a snapshot, so a new one replaces the one that is open
  const stale = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => STACKED_TITLE.exec(tab.label)?.[1] === scope)
  if (stale.length > 0) await vscode.window.tabGroups.close(stale, true)

  await vscode.commands.executeCommand(
    'vscode.changes',
    `${options.onlyUnviewed ? 'Unviewed' : 'All'} Changes in ${scope}`,
    resources,
  )
}

/**
 * Opens the diff of a file. In `auto` mode a file that changed after it was
 * viewed opens with only the changes made since then.
 */
export async function openFileDiff(
  services: Services,
  prKey: string,
  path: string,
  mode: DiffMode,
  options: { preserveFocus?: boolean; preview?: boolean } = {},
): Promise<void> {
  const loaded = await loadFile(services, prKey, path)
  if (!loaded) return
  const { detail, file } = loaded

  const baseline = services.store.getBaselines(prKey)[path]

  if (mode === 'sinceViewed' && !baseline) {
    void vscode.window.showInformationMessage(
      `There is no record of when ${baseName(path)} was viewed. Use "Open Changes Since Commit…" to pick a starting point.`,
    )
    return
  }

  const { ref, sinceViewed } = leftOf(mode, detail, file, baseline)
  const left = toDocUri(ref)
  const label = sinceViewed ? 'Changes Since Viewed' : `Pull Request #${detail.summary.number}`

  const right = await resolveHeadUri(services, prKey, detail, file)

  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${baseName(path)} (${label})`,
    { preview: options.preview ?? true, preserveFocus: options.preserveFocus ?? false },
  )
}

/** Opens the changes of a file since a commit of the pull request */
export async function openDiffSinceCommit(
  services: Services,
  prKey: string,
  path: string,
  commit: { oid: string; abbreviatedOid: string },
): Promise<void> {
  const loaded = await loadFile(services, prKey, path)
  if (!loaded) return
  const { detail, file } = loaded

  const left = toDocUri(commitDocRef(detail, file, commit.oid))
  const right = await resolveHeadUri(services, prKey, detail, file)
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    right,
    `${baseName(path)} (Changes Since ${commit.abbreviatedOid})`,
    { preview: true },
  )
}
