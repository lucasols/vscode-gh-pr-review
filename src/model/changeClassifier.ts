import type { ContentService } from '../content/contentService'
import { baseDocRef, headDocRef, viewedDocRef, type DocRef } from '../content/docRef'
import { errorMessage } from '../util/async'
import { Emitter } from '../util/emitter'
import {
  canHaveImportOnlyChanges,
  isImportOnlyChange,
  patchMayBeImportOnly,
} from '../util/importOnly'
import { isLockfile } from '../util/lockfiles'
import { isChangedSinceViewed, type Baseline } from './baselines'
import { headBlobId, summaryKey, type PrDetail, type PrFile } from './types'

/**
 * What kind of change a file has. The kinds other than `relevant` are noise
 * in most reviews and can be marked as viewed automatically:
 * - `lockfile`: a file that a package manager generates
 * - `renameOnly`: the file moved and its content is the same
 * - `importsOnly`: only import statements changed (TypeScript and JavaScript)
 */
export type ChangeKind = 'relevant' | 'lockfile' | 'renameOnly' | 'importsOnly'
export type NonRelevantChangeKind = Exclude<ChangeKind, 'relevant'>

export const CHANGE_KIND_LABELS: Record<NonRelevantChangeKind, string> = {
  lockfile: 'lockfile',
  renameOnly: 'rename only',
  importsOnly: 'imports only',
}

const MAX_PARALLEL = 4

type Job = { key: string; prKey: string; before: DocRef; after: DocRef }

/**
 * Classifies the changes of a file that the user still has to review: the
 * changes since the file was viewed when there is a baseline, the whole diff
 * of the pull request otherwise.
 *
 * Import-only changes need the content of both versions, so they are computed
 * in the background and announced when they are known.
 */
export class ChangeClassifier {
  private readonly emitter = new Emitter<string>()
  /** Fires with the key of the pull request that has a new result */
  readonly onDidChange = this.emitter.event

  private readonly importResults = new Map<string, boolean>()
  private readonly queued = new Set<string>()
  private readonly queue: Job[] = []
  private active = 0

  constructor(
    private readonly content: Pick<ContentService, 'readText'>,
    private readonly log: (message: string) => void,
  ) {}

  /** Returns undefined while the answer is being computed */
  classify(
    detail: PrDetail,
    file: PrFile,
    baseline: Baseline | undefined,
  ): ChangeKind | undefined {
    if (isLockfile(file.path)) return 'lockfile'

    const headBlob = headBlobId(file)
    if (file.status === 'removed' || file.status === 'added' || !headBlob) {
      return 'relevant'
    }

    const sinceViewed = isChangedSinceViewed(file, baseline)

    if (
      !sinceViewed &&
      file.status === 'renamed' &&
      file.additions === 0 &&
      file.deletions === 0
    ) {
      return 'renameOnly'
    }

    if (!canHaveImportOnlyChanges(file.path)) return 'relevant'

    const after = headDocRef(detail, file)
    let before: DocRef
    let key: string

    if (sinceViewed) {
      before = viewedDocRef(detail, file, baseline)
      if (before.side === 'empty') return 'relevant'
      key = `${baseline.blob}>${headBlob}`
    } else {
      // the patch rules out most files without reading their content
      if (!patchMayBeImportOnly(file.patch)) return 'relevant'
      before = baseDocRef(detail, file)
      key = `${detail.mergeBaseOid}:${file.previousPath ?? file.path}>${headBlob}`
    }

    const known = this.importResults.get(key)
    if (known !== undefined) return known ? 'importsOnly' : 'relevant'

    if (!this.queued.has(key)) {
      this.queued.add(key)
      this.queue.push({ key, prKey: summaryKey(detail.summary), before, after })
      this.drain()
    }
    return undefined
  }

  private drain(): void {
    while (this.active < MAX_PARALLEL) {
      const job = this.queue.shift()
      if (!job) return
      this.active++
      void this.run(job).finally(() => {
        this.active--
        this.drain()
      })
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      const [before, after] = await Promise.all([
        this.content.readText(job.before),
        this.content.readText(job.after),
      ])
      this.importResults.set(job.key, isImportOnlyChange(before, after))
    } catch (error) {
      // unknown content is treated as a change that must be reviewed
      this.log(`Could not analyze the imports of ${job.after.path}: ${errorMessage(error)}`)
      this.importResults.set(job.key, false)
    } finally {
      this.queued.delete(job.key)
    }
    this.emitter.fire(job.prKey)
  }

  dispose(): void {
    this.emitter.dispose()
  }
}
