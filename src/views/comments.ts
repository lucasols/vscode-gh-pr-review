import { join, relative, sep } from 'node:path'
import * as vscode from 'vscode'
import {
  baseDocRef,
  docRefPrKey,
  encodeDocRef,
  headDocRef,
  type DocRef,
} from '../content/docRef'
import { fromDocUri, toDocUri } from '../content/ghprFs'
import { logWarn } from '../log'
import type { CommentTarget } from '../model/prStore'
import type {
  DiffSide,
  PrDetail,
  PrFile,
  ReviewComment,
  ReviewThread,
} from '../model/types'
import type { Services } from '../services'
import { SerialTask, debounce, errorMessage } from '../util/async'
import { createLineMapper, type LineMapper } from '../util/lineMap'
import { isLineInRanges, parsePatchLines, type LineRange } from '../util/patch'

type ThreadInfo = { prKey: string; threadId: string }

class PrComment implements vscode.Comment {
  body: string | vscode.MarkdownString
  mode = vscode.CommentMode.Preview
  author: vscode.CommentAuthorInformation
  contextValue: string
  label: string | undefined
  timestamp: Date | undefined

  constructor(
    readonly prKey: string,
    readonly data: ReviewComment,
    readonly thread: () => vscode.CommentThread | undefined,
  ) {
    this.body = new vscode.MarkdownString(data.body)
    this.author = {
      name: data.author?.login ?? 'ghost',
      iconPath: data.author?.avatarUrl ? vscode.Uri.parse(data.author.avatarUrl) : undefined,
    }
    this.contextValue = [data.canEdit ? 'canEdit' : '', data.canDelete ? 'canDelete' : '']
      .filter(Boolean)
      .join(' ')
    this.label = data.isPending ? 'Pending' : undefined
    const time = Date.parse(data.createdAt)
    this.timestamp = Number.isNaN(time) ? undefined : new Date(time)
  }
}

type ThreadRecord = {
  thread: vscode.CommentThread
  signature: string
  info: ThreadInfo
}

type DesiredThread = {
  uri: vscode.Uri
  /** Undefined for a comment on the whole file */
  range: vscode.Range | undefined
  prKey: string
  data: ReviewThread
}

function isCommentReply(value: unknown): value is vscode.CommentReply {
  if (typeof value !== 'object' || value === null) return false
  if (!('thread' in value) || !('text' in value)) return false
  const { thread, text } = value
  return (
    typeof text === 'string' &&
    typeof thread === 'object' &&
    thread !== null &&
    'uri' in thread &&
    thread.uri instanceof vscode.Uri
  )
}

function toRange(start: number, end: number): vscode.Range {
  return new vscode.Range(start - 1, 0, end - 1, 0)
}

/**
 * Shows the review threads of the loaded pull requests in the editors and
 * creates, edits and resolves them. The threads are a projection of the store:
 * after every change they are reconciled with what GitHub has.
 */
export class CommentsController implements vscode.Disposable {
  private readonly controller: vscode.CommentController
  private readonly records = new Map<string, ThreadRecord>()
  private readonly threadInfo = new WeakMap<object, ThreadInfo>()
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly reconcileTask = new SerialTask(() => this.reconcile())
  private readonly reconcileSoon = debounce(() => void this.reconcileTask.run(), 50)

  constructor(private readonly services: Services) {
    this.controller = vscode.comments.createCommentController('ghPrReview', 'GH PR Review')
    this.controller.options = {
      prompt: 'Add a comment',
      placeHolder: 'Leave a comment on this line',
    }
    this.setRangeProvider()

    const { store } = services
    this.subscriptions.push(
      this.controller,
      store.onDidChangeDetail(() => this.reconcileSoon.call()),
      store.onDidChangeLists(() => this.reconcileSoon.call()),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.findLocalFile(document.uri)) this.reconcileSoon.call()
      }),
      vscode.commands.registerCommand('ghPrReview.comment.addSingle', (arg: unknown) =>
        this.submit(arg, 'single'),
      ),
      vscode.commands.registerCommand('ghPrReview.comment.startReview', (arg: unknown) =>
        this.submit(arg, 'review'),
      ),
      vscode.commands.registerCommand('ghPrReview.comment.addToReview', (arg: unknown) =>
        this.submit(arg, 'review'),
      ),
      vscode.commands.registerCommand('ghPrReview.comment.resolve', (arg: unknown) =>
        this.setResolved(arg, true),
      ),
      vscode.commands.registerCommand('ghPrReview.comment.unresolve', (arg: unknown) =>
        this.setResolved(arg, false),
      ),
      vscode.commands.registerCommand('ghPrReview.comment.edit', (arg: unknown) =>
        this.startEdit(arg),
      ),
      vscode.commands.registerCommand('ghPrReview.comment.cancelEdit', (arg: unknown) =>
        this.cancelEdit(arg),
      ),
      vscode.commands.registerCommand('ghPrReview.comment.save', (arg: unknown) =>
        this.saveEdit(arg),
      ),
      vscode.commands.registerCommand('ghPrReview.comment.delete', (arg: unknown) =>
        this.deleteComment(arg),
      ),
    )
  }

  /** The number of threads that are shown, for tests */
  get threadCount(): number {
    return this.records.size
  }

  /** Setting the provider again makes VS Code ask for the ranges again */
  private setRangeProvider(): void {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.provideRanges(document),
    }
  }

  private currentFile(
    ref: DocRef,
  ): { prKey: string; detail: PrDetail; file: PrFile; side: DiffSide } | undefined {
    if (ref.side !== 'head' && ref.side !== 'base') return undefined
    const prKey = docRefPrKey(ref)
    const detail = this.services.store.getDetail(prKey)
    const file = detail?.files.find((item) => item.path === ref.path)
    if (!detail || !file) return undefined

    // comments can only be placed on the versions that the pull request has now
    const current = ref.side === 'head' ? headDocRef(detail, file) : baseDocRef(detail, file)
    if (encodeDocRef(current) !== encodeDocRef(ref)) return undefined
    return { prKey, detail, file, side: ref.side === 'head' ? 'RIGHT' : 'LEFT' }
  }

  /** A file of the workspace that belongs to the pull request of its branch */
  private findLocalFile(
    uri: vscode.Uri,
  ): { prKey: string; detail: PrDetail; file: PrFile } | undefined {
    if (uri.scheme !== 'file') return undefined
    const { store } = this.services

    for (const prKey of store.getCheckedOutKeys()) {
      const repo = store.getCheckoutOf(prKey)
      const detail = store.getDetail(prKey)
      if (!repo || !detail) continue
      if (!uri.fsPath.startsWith(repo.rootPath + sep)) continue

      const path = relative(repo.rootPath, uri.fsPath).split(sep).join('/')
      const file = detail.files.find((item) => item.path === path)
      if (file && file.status !== 'removed') return { prKey, detail, file }
    }
    return undefined
  }

  /** Maps the lines of the pull request version to the file of the workspace */
  private async getLocalMapper(
    detail: PrDetail,
    file: PrFile,
    uri: vscode.Uri,
  ): Promise<LineMapper | undefined> {
    try {
      const open = vscode.workspace.textDocuments.find(
        (document) => document.uri.toString() === uri.toString(),
      )
      const localText =
        open ?
          open.getText()
        : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))
      const headText = await this.services.content.readText(headDocRef(detail, file))
      return createLineMapper(headText, localText)
    } catch {
      return undefined
    }
  }

  private async provideRanges(
    document: vscode.TextDocument,
  ): Promise<vscode.CommentingRanges | undefined> {
    const ref = fromDocUri(document.uri)
    if (ref) {
      const current = this.currentFile(ref)
      if (!current) return undefined
      const lines = parsePatchLines(current.file.patch)
      const ranges = current.side === 'RIGHT' ? lines.right : lines.left
      return {
        enableFileComments: true,
        ranges: ranges.map((range) => toRange(range.start, range.end)),
      }
    }

    const local = this.findLocalFile(document.uri)
    if (!local) return undefined
    const mapper = await this.getLocalMapper(local.detail, local.file, document.uri)
    if (!mapper) return undefined

    const ranges: vscode.Range[] = []
    for (const range of parsePatchLines(local.file.patch).right) {
      let start: number | undefined
      let previous: number | undefined
      for (let line = range.start; line <= range.end; line++) {
        const mapped = mapper.toTarget(line)
        if (mapped !== undefined && previous !== undefined && mapped === previous + 1) {
          previous = mapped
          continue
        }
        if (start !== undefined && previous !== undefined) {
          ranges.push(toRange(start, previous))
        }
        start = mapped
        previous = mapped
      }
      if (start !== undefined && previous !== undefined) ranges.push(toRange(start, previous))
    }
    return { enableFileComments: false, ranges }
  }

  private async collectDesired(): Promise<Map<string, DesiredThread>> {
    const { store } = this.services
    const desired = new Map<string, DesiredThread>()
    const add = (item: DesiredThread) => {
      desired.set(`${item.data.id}|${item.uri.toString()}`, item)
    }

    for (const prKey of store.getLoadedKeys()) {
      const detail = store.getDetail(prKey)
      if (!detail) continue
      const checkout = store.getCheckoutOf(prKey)
      const mappers = new Map<string, LineMapper | undefined>()

      for (const data of detail.threads) {
        if (data.isOutdated || data.comments.length === 0) continue
        if (!data.isFileLevel && data.line === undefined) continue
        const file = detail.files.find((item) => item.path === data.path)
        if (!file) continue

        const ref = data.side === 'RIGHT' ? headDocRef(detail, file) : baseDocRef(detail, file)
        if (ref.side === 'empty') continue

        const endLine = data.line
        const startLine = data.startLine ?? data.line
        const range =
          endLine !== undefined && startLine !== undefined ?
            toRange(startLine, endLine)
          : undefined
        add({ uri: toDocUri(ref), range, prKey, data })

        // the same thread in the file of the workspace, when the branch is checked out
        if (data.side !== 'RIGHT' || !checkout || file.status === 'removed') continue
        const localUri = vscode.Uri.file(join(checkout.rootPath, file.path))
        if (!mappers.has(file.path)) {
          mappers.set(file.path, await this.getLocalMapper(detail, file, localUri))
        }
        const mapper = mappers.get(file.path)
        if (!mapper) continue

        if (endLine === undefined || startLine === undefined) {
          add({ uri: localUri, range: undefined, prKey, data })
          continue
        }
        const mappedEnd = mapper.toTarget(endLine)
        if (mappedEnd === undefined) continue
        const mappedStart = mapper.toTarget(startLine) ?? mappedEnd
        add({ uri: localUri, range: toRange(mappedStart, mappedEnd), prKey, data })
      }
    }

    return desired
  }

  private applyThread(record: ThreadRecord, item: DesiredThread): void {
    const { thread } = record
    const { data } = item

    const isEditing = thread.comments.some(
      (comment) => comment.mode === vscode.CommentMode.Editing,
    )
    if (isEditing) return

    thread.range = item.range
    thread.comments = data.comments.map(
      (comment) => new PrComment(item.prKey, comment, () => thread),
    )
    thread.state =
      data.isResolved ?
        vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved
    thread.canReply = data.canReply
    thread.label =
      data.isResolved ? 'Resolved'
      : data.comments.some((comment) => comment.isPending) ? 'Pending review'
      : undefined
    thread.contextValue = [
      !data.isResolved && data.canResolve ? 'canResolve' : '',
      data.isResolved && data.canUnresolve ? 'canUnresolve' : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  private async reconcile(): Promise<void> {
    let desired: Map<string, DesiredThread>
    try {
      desired = await this.collectDesired()
    } catch (error) {
      logWarn(`Could not place the review comments: ${errorMessage(error)}`)
      return
    }

    for (const [key, record] of this.records) {
      if (desired.has(key)) continue
      record.thread.dispose()
      this.records.delete(key)
    }

    for (const [key, item] of desired) {
      const signature = JSON.stringify([
        item.data,
        item.range ? [item.range.start.line, item.range.end.line] : null,
      ])
      let record = this.records.get(key)

      if (!record) {
        const thread = this.controller.createCommentThread(
          item.uri,
          item.range ?? new vscode.Range(0, 0, 0, 0),
          [],
        )
        // new threads start collapsed when they are resolved
        thread.collapsibleState =
          item.data.isResolved ?
            vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded
        const info: ThreadInfo = { prKey: item.prKey, threadId: item.data.id }
        this.threadInfo.set(thread, info)
        record = { thread, signature: '', info }
        this.records.set(key, record)
      }

      if (record.signature === signature) continue
      const wasResolved = record.thread.state === vscode.CommentThreadState.Resolved
      this.applyThread(record, item)
      if (record.thread.comments.some((c) => c.mode === vscode.CommentMode.Editing)) continue
      record.signature = signature
      if (item.data.isResolved && !wasResolved) {
        record.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed
      }
    }

    // the lines that can be commented depend on the loaded pull requests
    this.setRangeProvider()
  }

  private async resolveNewThread(
    thread: vscode.CommentThread,
  ): Promise<{ prKey: string; target: CommentTarget } | string> {
    const start = thread.range ? thread.range.start.line + 1 : undefined
    const end = thread.range ? thread.range.end.line + 1 : undefined
    const NOT_IN_DIFF = 'GitHub only accepts comments on lines that are part of the diff.'

    const check = (
      prKey: string,
      file: PrFile,
      side: DiffSide,
      startLine: number | undefined,
      line: number | undefined,
    ): { prKey: string; target: CommentTarget } | string => {
      if (line !== undefined) {
        const lines = parsePatchLines(file.patch)
        const ranges: LineRange[] = side === 'RIGHT' ? lines.right : lines.left
        const from = startLine ?? line
        if (!isLineInRanges(line, ranges) || !isLineInRanges(from, ranges)) return NOT_IN_DIFF
      }
      return {
        prKey,
        target: { kind: 'thread', path: file.path, line, startLine, side },
      }
    }

    const ref = fromDocUri(thread.uri)
    if (ref) {
      const current = this.currentFile(ref)
      if (!current) {
        return 'This is not the current version of the file. Open the file again from the Changes view to comment.'
      }
      return check(current.prKey, current.file, current.side, start, end)
    }

    const local = this.findLocalFile(thread.uri)
    if (!local) return 'This file is not part of a pull request.'
    if (start === undefined || end === undefined) {
      return check(local.prKey, local.file, 'RIGHT', undefined, undefined)
    }

    const mapper = await this.getLocalMapper(local.detail, local.file, thread.uri)
    const line = mapper?.toSource(end)
    const startLine = mapper?.toSource(start)
    if (line === undefined || startLine === undefined) {
      return 'This line has local changes that are not in the pull request yet. Push them before commenting.'
    }
    return check(local.prKey, local.file, 'RIGHT', startLine, line)
  }

  private async submit(arg: unknown, mode: 'single' | 'review'): Promise<void> {
    if (!isCommentReply(arg)) return
    const text = arg.text.trim()
    if (!text) return
    const { store } = this.services

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Adding comment…' },
        async () => {
          const info = this.threadInfo.get(arg.thread)
          if (info) {
            await store.addComment(
              info.prKey,
              { kind: 'reply', threadId: info.threadId },
              text,
              mode,
            )
            return
          }

          const resolved = await this.resolveNewThread(arg.thread)
          if (typeof resolved === 'string') throw new Error(resolved)
          await store.addComment(resolved.prKey, resolved.target, text, mode)
          // the thread that GitHub created replaces the draft
          arg.thread.dispose()
        },
      )
      await this.reconcileTask.run()
    } catch (error) {
      const choice = await vscode.window.showErrorMessage(
        `Could not add the comment: ${errorMessage(error)}`,
        'Copy Comment',
      )
      if (choice === 'Copy Comment') await vscode.env.clipboard.writeText(text)
    }
  }

  private async setResolved(arg: unknown, resolved: boolean): Promise<void> {
    if (typeof arg !== 'object' || arg === null) return
    const info = this.threadInfo.get(arg)
    if (!info) return
    try {
      await this.services.store.setThreadResolved(info.prKey, info.threadId, resolved)
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not ${resolved ? 'resolve' : 'unresolve'} the conversation: ${errorMessage(error)}`,
      )
    }
  }

  private refreshThread(comment: PrComment): void {
    const thread = comment.thread()
    if (thread) thread.comments = [...thread.comments]
  }

  private startEdit(arg: unknown): void {
    if (!(arg instanceof PrComment)) return
    arg.body = arg.data.body
    arg.mode = vscode.CommentMode.Editing
    this.refreshThread(arg)
  }

  private cancelEdit(arg: unknown): void {
    if (!(arg instanceof PrComment)) return
    arg.body = new vscode.MarkdownString(arg.data.body)
    arg.mode = vscode.CommentMode.Preview
    this.refreshThread(arg)
    this.reconcileSoon.call()
  }

  private async saveEdit(arg: unknown): Promise<void> {
    if (!(arg instanceof PrComment)) return
    const text = typeof arg.body === 'string' ? arg.body : arg.body.value
    if (!text.trim()) return

    try {
      arg.body = new vscode.MarkdownString(text)
      arg.mode = vscode.CommentMode.Preview
      this.refreshThread(arg)
      await this.services.store.editComment(arg.prKey, arg.data.id, text)
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not save the comment: ${errorMessage(error)}`,
      )
      this.reconcileSoon.call()
    }
  }

  private async deleteComment(arg: unknown): Promise<void> {
    if (!(arg instanceof PrComment)) return
    const choice = await vscode.window.showWarningMessage(
      'Delete this comment?',
      { modal: true },
      'Delete',
    )
    if (choice !== 'Delete') return
    try {
      await this.services.store.deleteComment(arg.prKey, arg.data.id)
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not delete the comment: ${errorMessage(error)}`,
      )
    }
  }

  dispose(): void {
    this.reconcileSoon.cancel()
    for (const record of this.records.values()) record.thread.dispose()
    this.records.clear()
    for (const subscription of this.subscriptions) subscription.dispose()
  }
}
