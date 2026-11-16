import { join } from 'node:path'
import * as vscode from 'vscode'
import { config } from '../config'
import { baseDocRef, commitDocRef, headDocRef, viewedDocRef } from '../content/docRef'
import { toDocUri } from '../content/ghprFs'
import { isChangedSinceViewed } from '../model/baselines'
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
  let left: vscode.Uri
  let label: string

  if (mode === 'sinceViewed' && !baseline) {
    void vscode.window.showInformationMessage(
      `There is no record of when ${baseName(path)} was viewed. Use "Open Changes Since Commit…" to pick a starting point.`,
    )
    return
  }

  const showSinceViewed =
    baseline !== undefined &&
    (mode === 'sinceViewed' ||
      (mode === 'auto' &&
        config.defaultDiff() === 'sinceViewed' &&
        isChangedSinceViewed(file, baseline)))

  if (showSinceViewed) {
    left = toDocUri(viewedDocRef(detail, file, baseline))
    label = 'Changes Since Viewed'
  } else {
    left = toDocUri(baseDocRef(detail, file))
    label = `Pull Request #${detail.summary.number}`
  }

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
