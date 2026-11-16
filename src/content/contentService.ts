import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRepoKey } from '../util/remoteUrl'
import type { DocRef } from './docRef'

export type ContentSource = {
  readBlob: (
    repo: { owner: string; name: string },
    sha: string,
  ) => Promise<Uint8Array | undefined>
  readFileAtCommit: (
    repo: { owner: string; name: string },
    commit: string,
    path: string,
  ) => Promise<Uint8Array | undefined>
}

export type LocalGit = {
  /** The folder of a local clone of the repository, if there is one */
  findRoot: (repo: string) => string | undefined
  run: (cwd: string, args: readonly string[]) => Promise<Buffer>
}

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
const DISK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const EMPTY = new Uint8Array()

/**
 * Reads the versions of the files of a pull request. Every version is
 * addressed by a git hash, so it never changes and can be cached forever:
 * in memory, on disk, and read from the local clone when it has the object.
 */
export class ContentService {
  private readonly memory = new Map<string, Uint8Array>()
  private memoryBytes = 0
  private readonly inflight = new Map<string, Promise<Uint8Array>>()

  constructor(
    private readonly source: ContentSource,
    private readonly localGit: LocalGit,
    private readonly cacheDir: string,
  ) {}

  private static key(ref: DocRef): string | undefined {
    if (ref.side === 'empty') return undefined
    if (ref.blob) return `blob:${ref.blob}`
    if (ref.commit && ref.srcPath) return `commit:${ref.commit}:${ref.srcPath}`
    return undefined
  }

  read(ref: DocRef): Promise<Uint8Array> {
    const key = ContentService.key(ref)
    if (!key) return Promise.resolve(EMPTY)

    const cached = this.memory.get(key)
    if (cached) return Promise.resolve(cached)

    let pending = this.inflight.get(key)
    if (!pending) {
      pending = this.load(ref, key).finally(() => this.inflight.delete(key))
      this.inflight.set(key, pending)
    }
    return pending
  }

  async readText(ref: DocRef): Promise<string> {
    return new TextDecoder().decode(await this.read(ref))
  }

  private remember(key: string, content: Uint8Array): void {
    if (content.byteLength > MEMORY_LIMIT_BYTES / 4) return
    this.memory.set(key, content)
    this.memoryBytes += content.byteLength
    for (const [oldKey, oldContent] of this.memory) {
      if (this.memoryBytes <= MEMORY_LIMIT_BYTES) break
      this.memory.delete(oldKey)
      this.memoryBytes -= oldContent.byteLength
    }
  }

  private diskPath(key: string): string {
    return join(this.cacheDir, createHash('sha1').update(key).digest('hex'))
  }

  private async load(ref: DocRef, key: string): Promise<Uint8Array> {
    const diskPath = this.diskPath(key)
    try {
      const content = new Uint8Array(await readFile(diskPath))
      this.remember(key, content)
      return content
    } catch {
      // not in the disk cache
    }

    const local = await this.readFromLocalGit(ref)
    if (local) {
      this.remember(key, local)
      return local
    }

    const repo = parseRepoKey(ref.repo)
    if (!repo) return EMPTY

    let content: Uint8Array | undefined
    if (ref.blob) {
      content = await this.source.readBlob(repo, ref.blob)
    } else if (ref.commit && ref.srcPath) {
      content = await this.source.readFileAtCommit(repo, ref.commit, ref.srcPath)
    }
    const result = content ?? EMPTY

    this.remember(key, result)
    void this.writeToDisk(diskPath, result)
    return result
  }

  private async readFromLocalGit(ref: DocRef): Promise<Uint8Array | undefined> {
    const root = this.localGit.findRoot(ref.repo)
    if (!root) return undefined

    try {
      if (ref.blob) {
        return new Uint8Array(await this.localGit.run(root, ['cat-file', 'blob', ref.blob]))
      }
      if (ref.commit && ref.srcPath) {
        // only trust "the file does not exist" when the commit is known locally
        await this.localGit.run(root, ['cat-file', '-e', `${ref.commit}^{commit}`])
        try {
          return new Uint8Array(
            await this.localGit.run(root, [
              'cat-file',
              'blob',
              `${ref.commit}:${ref.srcPath}`,
            ]),
          )
        } catch {
          return EMPTY
        }
      }
    } catch {
      // the local clone does not have the object, GitHub has it
    }
    return undefined
  }

  private async writeToDisk(path: string, content: Uint8Array): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, content)
      await rename(temp, path)
    } catch {
      // the disk cache is only an optimization
    }
  }

  /** Removes the cached files that were not written for a long time */
  async pruneDisk(now: number): Promise<void> {
    try {
      for (const name of await readdir(this.cacheDir)) {
        const path = join(this.cacheDir, name)
        const info = await stat(path)
        if (now - info.mtimeMs > DISK_MAX_AGE_MS) await unlink(path)
      }
    } catch {
      // nothing was cached yet
    }
  }
}
