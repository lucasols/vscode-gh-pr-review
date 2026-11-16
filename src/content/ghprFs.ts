import * as vscode from 'vscode'
import type { ContentService } from './contentService'
import { decodeDocRef, encodeDocRef, type DocRef } from './docRef'

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
 */
export class GhprFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  readonly onDidChangeFile = this.emitter.event

  constructor(private readonly content: ContentService) {}

  private async load(uri: vscode.Uri): Promise<Uint8Array> {
    const ref = fromDocUri(uri)
    if (!ref) throw vscode.FileSystemError.FileNotFound(uri)
    try {
      return await this.content.read(ref)
    } catch (error) {
      throw vscode.FileSystemError.Unavailable(
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  watch(): vscode.Disposable {
    // the content of a version never changes
    return new vscode.Disposable(() => undefined)
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const content = await this.load(uri)
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
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
