import { relative, sep } from 'node:path'
import * as vscode from 'vscode'
import { docRefPrKey, headDocRef } from '../content/docRef'
import { fromDocUri } from '../content/ghprFs'
import { isFullyReviewed } from '../model/lineReviews'
import { openFileDiff } from './diffOpener'
import type { PrDetail, PrFile } from '../model/types'
import type { Services } from '../services'
import { errorMessage } from '../util/async'
import { gitBlobSha } from '../util/gitBlobHash'
import { IDENTITY_MAPPER, createLineMapper, type LineMapper } from '../util/lineMap'
import { mapRanges } from '../util/lineRanges'
import type { LineRange } from '../util/patch'
import { warnAboutLocalChanges } from './localChanges'

/** A document that shows a version of a file of a pull request whose lines can be marked */
type EditorTarget =
  | {
      kind: 'current'
      prKey: string
      detail: PrDetail
      file: PrFile
      /** Maps the lines of the head version (source) to the document (target) */
      mapper: LineMapper
    }
  /** The diff was opened before the file changed in the pull request */
  | { kind: 'stale'; prKey: string; path: string }

/** The lines (1-based) that the selections of an editor cover */
function selectedLines(editor: vscode.TextEditor): LineRange[] {
  return editor.selections.map((selection) => {
    const start = selection.start.line + 1
    // a selection that ends at the start of a line does not include it
    const endsAtLineStart =
      selection.end.character === 0 && selection.end.line > selection.start.line
    const end = endsAtLineStart ? selection.end.line : selection.end.line + 1
    return { start, end }
  })
}

/**
 * Marks changed lines as reviewed, like staging them: the default diff of a
 * file compares with its reviewed version, so they leave the diff. Lines can
 * be marked in both sides of the diff and in the file of the workspace. A
 * file whose changed lines are all reviewed is marked as viewed.
 */
export class LineReviewController implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[]

  constructor(private readonly services: Services) {
    this.subscriptions = [
      vscode.commands.registerCommand('ghPrReview.markLinesReviewed', () =>
        this.mark('selection', true),
      ),
      vscode.commands.registerCommand('ghPrReview.markLinesNotReviewed', () =>
        this.mark('selection', false),
      ),
      vscode.commands.registerCommand('ghPrReview.markAboveReviewed', () =>
        this.mark('above', true),
      ),
    ]
  }

  private async resolve(document: vscode.TextDocument): Promise<EditorTarget | undefined> {
    const { store, content, lineReviews } = this.services
    const ref = fromDocUri(document.uri)
    if (ref) {
      if ((ref.side !== 'head' && ref.side !== 'reviewed') || ref.blob === undefined) {
        return undefined
      }
      const prKey = docRefPrKey(ref)
      const detail = store.getDetail(prKey)
      const file = detail?.files.find((item) => item.path === ref.path)
      if (!detail || !file) return undefined
      // an editor that was opened before a push shows a version that is gone
      if (file.blobSha !== ref.blob) return { kind: 'stale', prKey, path: file.path }
      if (ref.side === 'head') {
        return { kind: 'current', prKey, detail, file, mapper: IDENTITY_MAPPER }
      }

      // the reviewed version has the lines of the head version that were reviewed
      const head = await content.readText(headDocRef(detail, file))
      const reviewed = await lineReviews.reviewedText(
        detail,
        file,
        store.getBaselines(prKey)[file.path],
      )
      return { kind: 'current', prKey, detail, file, mapper: createLineMapper(head, reviewed) }
    }

    if (document.uri.scheme !== 'file') return undefined
    const local = this.findLocalFile(document.uri)
    if (!local?.file.blobSha) return undefined

    // the file of the workspace can have edits that the pull request does not have
    const text = document.getText()
    if (gitBlobSha(new TextEncoder().encode(text)) === local.file.blobSha) {
      return { kind: 'current', ...local, mapper: IDENTITY_MAPPER }
    }
    const head = await content.readText(headDocRef(local.detail, local.file))
    return { kind: 'current', ...local, mapper: createLineMapper(head, text) }
  }

  /** A file of the workspace that belongs to the pull request of its branch */
  private findLocalFile(
    uri: vscode.Uri,
  ): { prKey: string; detail: PrDetail; file: PrFile } | undefined {
    const { store } = this.services
    const keys = new Set([store.focusedKey, ...store.getCheckedOutKeys()])
    for (const prKey of keys) {
      if (!prKey) continue
      const repo = store.getCheckoutOf(prKey) ?? store.getRepoForPr(prKey)
      const detail = store.getDetail(prKey)
      if (!repo || !detail || !uri.fsPath.startsWith(repo.rootPath + sep)) continue
      const path = relative(repo.rootPath, uri.fsPath).split(sep).join('/')
      const file = detail.files.find((item) => item.path === path)
      if (file && file.status !== 'removed') return { prKey, detail, file }
    }
    return undefined
  }

  private async mark(scope: 'selection' | 'above', reviewed: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const { store, lineReviews } = this.services

    try {
      const target = await this.resolve(editor.document)
      if (!target) {
        void vscode.window.showInformationMessage(
          'Lines can be marked as reviewed in the diff of the current version of a file of the pull request, or in the file of the workspace.',
        )
        return
      }
      if (target.kind === 'stale') {
        void vscode.window.showWarningMessage(
          'This file changed in the pull request after this diff was opened. The current version was opened instead: mark the lines there.',
        )
        await openFileDiff(this.services, target.prKey, target.path, 'auto')
        return
      }
      const { prKey, detail, file, mapper } = target
      const name = file.path.slice(file.path.lastIndexOf('/') + 1)
      if (file.viewedState === 'VIEWED') {
        void vscode.window.showInformationMessage(`${name} is already marked as viewed.`)
        return
      }

      let headLines: LineRange[]
      if (scope === 'above') {
        // everything of the head version up to the last line above the cursor that it has
        const cursor = editor.selection.active.line + 1
        const above = mapRanges([{ start: 1, end: cursor }], mapper.toSource)
        const last = above.at(-1)?.end
        headLines = last === undefined ? [] : [{ start: 1, end: last }]
      } else {
        headLines = mapRanges(selectedLines(editor), mapper.toSource)
      }

      const review = await lineReviews.setReviewed(
        detail,
        file,
        store.getBaselines(prKey)[file.path],
        headLines,
        reviewed,
      )
      if (!review) {
        void vscode.window.showInformationMessage(
          `${name} has no changed lines to review one by one. Mark it as viewed instead.`,
        )
        return
      }
      if (reviewed && isFullyReviewed(review)) {
        void vscode.window.setStatusBarMessage(
          `All changes of ${name} are reviewed, marked it as viewed`,
          5000,
        )
        void warnAboutLocalChanges(this.services, prKey, [file.path])
        await store.setViewed(prKey, [file.path], true)
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not mark the lines: ${errorMessage(error)}`)
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose()
  }
}
