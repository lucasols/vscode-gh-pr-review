import * as vscode from 'vscode'
import { config } from '../config'
import type { Services } from '../services'
import { gitBlobSha } from '../util/gitBlobHash'
import { getLocalFileUri } from './diffOpener'

async function differsFromBlob(document: vscode.TextDocument, blob: string): Promise<boolean> {
  // unsaved edits are not on the disk yet
  if (document.isDirty) return true
  try {
    return gitBlobSha(await vscode.workspace.fs.readFile(document.uri)) !== blob
  } catch {
    // the file was deleted from the workspace
    return true
  }
}

/**
 * A diff shows the file of the workspace while its content is the content of
 * the pull request. When that file is edited afterwards, the editor shows
 * changes that GitHub does not have, and GitHub marks its own version as
 * viewed. The user is told, because those edits will show up later as changes
 * made since the file was viewed.
 *
 * Call it before the files are marked: it only looks at the files that are
 * not viewed yet.
 */
export async function warnAboutLocalChanges(
  services: Services,
  prKey: string,
  paths: readonly string[],
): Promise<void> {
  const detail = services.store.getDetail(prKey)
  if (!detail || !config.useLocalFiles()) return

  // only a file that is open in an editor can show something else than GitHub has
  const open = new Map(
    vscode.workspace.textDocuments
      .filter((document) => document.uri.scheme === 'file')
      .map((document) => [document.uri.toString(), document]),
  )
  const wanted = new Set(paths)
  const candidates = detail.files.flatMap((file) => {
    if (!wanted.has(file.path) || file.viewedState === 'VIEWED') return []
    if (file.status === 'removed' || !file.blobSha) return []
    const document = open.get(getLocalFileUri(services, prKey, file.path)?.toString() ?? '')
    return document ? [{ path: file.path, blob: file.blobSha, document }] : []
  })
  if (candidates.length === 0) return

  const results = await Promise.all(
    candidates.map(async (item) =>
      (await differsFromBlob(item.document, item.blob)) ? item.path : undefined,
    ),
  )
  const changed = results.filter((path) => path !== undefined)
  const [first] = changed
  if (first === undefined) return

  void vscode.window.showWarningMessage(
    changed.length === 1 ?
      `${first.slice(first.lastIndexOf('/') + 1)} in the workspace differs from the pull request. The version of the pull request was marked as viewed.`
    : `${changed.length} files in the workspace differ from the pull request. The versions of the pull request were marked as viewed.`,
  )
}
