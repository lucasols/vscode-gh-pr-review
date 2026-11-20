import * as vscode from 'vscode'
import type { ContentService } from './contentService'
import { decodeDocRef, docRefPrKey, encodeDocRef, type DocRef } from './docRef'

/** Computes the content of the `reviewed` versions */
export type ReviewedSource = (ref: DocRef) => Promise<string>

export const GHPR_SCHEME = 'ghpr'

/** The URI of the document that shows a version of a file of a pull request */
export function toDocUri(ref: DocRef): vscode.Uri {
  return vscode.Uri.from({
    scheme: GHPR_SCHEME,
    path: `/${ref.path}`,
    query: encodeDocRef(ref),
  })
}

export function fromDocUri(uri: vscode.Uri): DocRef | undefined {
  if (uri.scheme !== GHPR_SCHEME) return undefined
  return decodeDocRef(uri.query)
}

/**
 * A read-only file system for the versions of the files of a pull request. A
 * file system is used instead of a text document provider because it also
 * works for images and other binary files.
 *
 * The versions are addressed by git hashes and never change, except the
 * `reviewed` ones. When those change, the documents that show them are told,
 * so the diffs that are open update like they do when lines are staged.
 */
export class GhprFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.emitter.event

  constructor(
    private readonly content: ContentService,
    private readonly reviewed: ReviewedSource,
  ) {}

  /** Tells the open documents of the reviewed versions of a pull request that they changed */
  reviewedChanged(prKey: string): void {
    const events: vscode.FileChangeEvent[] = []
    for (const document of vscode.workspace.textDocuments) {
      const ref = fromDocUri(document.uri)
      if (ref?.side === 'reviewed' && docRefPrKey(ref) === prKey) {
        events.push({ type: vscode.FileChangeType.Changed, uri: document.uri })
      }
    }
    if (events.length > 0) this.emitter.fire(events)
  }

  private async load(uri: vscode.Uri): Promise<Uint8Array> {
    const ref = fromDocUri(uri)
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri)
    try {
      if (ref.side === 'reviewed') return new TextEncoder().encode(await this.reviewed(ref))
      return await this.content.read(ref)
    } catch (error) {
      throw vscode.FileSystemError.Unavailable(
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  watch(): vscode.Disposable {
    // the changes of the reviewed versions are announced without watching
    return new vscode.Disposable(() => undefined)
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const content = await this.load(uri)
    // a new time makes VS Code read a reviewed version again after a change
    const changes = fromDocUri(uri)?.side === 'reviewed'
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: changes ? Date.now() : 0,
      size: content.byteLength,
      permissions: vscode.FilePermission.Readonly,
    }
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.load(uri)
  }

  readDirectory(): [string, vscode.FileType][] {
    return []
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri)
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri)
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri)
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri)
  }
}
