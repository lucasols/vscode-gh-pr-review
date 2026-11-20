import * as vscode from 'vscode'
import { docRefPrKey, encodeDocRef, type DocRef } from '../content/docRef'
import { fromDocUri, type ReviewedSource } from '../content/ghprFs'
import type { Services } from '../services'
import { gitBlobSha } from '../util/gitBlobHash'

/** The content of the right side of the open diff whose left side is `ref` */
async function rightSideBlob(ref: DocRef): Promise<string | undefined> {
  const wanted = encodeDocRef(ref)
  for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
    const input = tab.input
    if (!(input instanceof vscode.TabInputTextDiff)) continue
    const original = fromDocUri(input.original)
    if (!original || encodeDocRef(original) !== wanted) continue

    const right = input.modified
    if (right.scheme !== 'file') return fromDocUri(right)?.blob
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === right.toString(),
    )
    try {
      const bytes =
        open ? new TextEncoder().encode(open.getText()) : await vscode.workspace.fs.readFile(right)
      return gitBlobSha(bytes)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * The content of the reviewed version that a diff shows on its left side. It
 * belongs to the head version that the diff was opened with: after a push the
 * right side still shows that version, unless it is the file of the workspace
 * and the push was pulled.
 */
export function createReviewedSource(services: Services): ReviewedSource {
  const { store, lineReviews } = services
  return async (ref) => {
    const prKey = docRefPrKey(ref)
    if (!store.getDetail(prKey)) await store.refreshDetail(prKey)
    const detail = store.getDetail(prKey)
    const current = detail?.files.find((item) => item.path === ref.path)
    if (!detail || !current) throw new Error(`${ref.path} is not part of the pull request`)

    let file = current
    if (ref.blob !== undefined && current.blobSha !== ref.blob) {
      const shown = await rightSideBlob(ref)
      if (shown !== current.blobSha) file = { ...current, blobSha: ref.blob }
    }
    return lineReviews.reviewedText(detail, file, store.getBaselines(prKey)[file.path])
  }
}
