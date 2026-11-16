import { z } from 'zod'
import { headBlobId, type PrFile } from './types'

/**
 * GitHub knows that a file was marked as viewed, but not which version of it
 * was viewed. A baseline is our own record of that version, so that when the
 * file changes later we can show only what changed since then.
 */
const baselineSchema = z.object({
  /** Blob of the head version that was viewed (see `headBlobId`) */
  blob: z.string(),
  /** Head commit of the pull request when the baseline was recorded */
  commit: z.string(),
  at: z.number(),
})

export type Baseline = z.infer<typeof baselineSchema>
export type BaselineMap = Record<string, Baseline>

export const baselineMapSchema = z.record(z.string(), baselineSchema)

type FileForBaseline = Pick<PrFile, 'path' | 'status' | 'blobSha' | 'viewedState'>

/**
 * How long a new head commit must be known before a file that GitHub reports
 * as viewed can replace an existing baseline. Right after a push GitHub can
 * still report the old viewed state together with the new content, and
 * accepting that would lose the version that was really viewed.
 */
export const BASELINE_SETTLE_MS = 30_000

/**
 * Updates the baselines from what GitHub reports. A file stays viewed only
 * while it does not change, so a viewed file was viewed with its current
 * content, even when it was marked on github.com or in another editor.
 */
export function reconcileBaselines(args: {
  current: BaselineMap
  files: readonly FileForBaseline[]
  headSha: string
  /** When this head commit was first seen */
  headFirstSeenAt: number
  now: number
}): { next: BaselineMap; changed: boolean } {
  const { current, files, headSha, headFirstSeenAt, now } = args
  const next: BaselineMap = {}
  let changed = false
  const headSettled = now - headFirstSeenAt >= BASELINE_SETTLE_MS

  for (const file of files) {
    const existing = current[file.path]
    const blob = headBlobId(file)

    if (file.viewedState === 'VIEWED' && blob !== undefined) {
      if (!existing || (existing.blob !== blob && headSettled)) {
        next[file.path] = { blob, commit: headSha, at: now }
        changed = true
        continue
      }
    }

    if (existing) next[file.path] = existing
  }

  // files that left the pull request have nothing left to compare
  if (Object.keys(next).length !== Object.keys(current).length) changed = true

  return { next, changed }
}

/** Records the versions that the user marked as viewed in this extension */
export function markViewedBaselines(
  current: BaselineMap,
  files: readonly { path: string; blob: string | undefined }[],
  headSha: string,
  now: number,
): BaselineMap {
  const next = { ...current }
  for (const file of files) {
    if (file.blob === undefined) continue
    next[file.path] = { blob: file.blob, commit: headSha, at: now }
  }
  return next
}

export function removeBaselines(
  current: BaselineMap,
  paths: readonly string[],
): BaselineMap {
  const next = { ...current }
  for (const path of paths) delete next[path]
  return next
}

/**
 * Whether the file has changes that were made after it was viewed and that
 * can be shown on their own.
 */
export function isChangedSinceViewed(
  file: FileForBaseline,
  baseline: Baseline | undefined,
): baseline is Baseline {
  if (!baseline || file.viewedState === 'VIEWED') return false
  const blob = headBlobId(file)
  return blob !== undefined && blob !== baseline.blob
}

export type BaselineStorage = {
  keys: () => readonly string[]
  get: (key: string) => unknown
  update: (key: string, value: unknown) => PromiseLike<void>
}

const STORAGE_PREFIX = 'baselines:v1:'
const MAX_STORED_PRS = 300

const storedSchema = z.object({ updatedAt: z.number(), files: baselineMapSchema })

/** Keeps the baselines of each pull request in the storage of the extension */
export class BaselineStore {
  /**
   * The parsed value of each stored entry. The storage is shared with the
   * other windows, which can replace an entry at any time, so a parsed value
   * is only reused while the stored value is still the same object.
   */
  private readonly cache = new Map<string, { raw: unknown; files: BaselineMap }>()

  constructor(private readonly storage: BaselineStorage) {}

  get(prKey: string): BaselineMap {
    const raw = this.storage.get(STORAGE_PREFIX + prKey)
    const cached = this.cache.get(prKey)
    if (cached && cached.raw === raw) return cached.files

    const parsed = storedSchema.safeParse(raw)
    const files = parsed.success ? parsed.data.files : {}
    this.cache.set(prKey, { raw, files })
    return files
  }

  set(prKey: string, files: BaselineMap, now: number): void {
    const isEmpty = Object.keys(files).length === 0
    const raw = isEmpty ? undefined : { updatedAt: now, files }
    this.cache.set(prKey, { raw, files })
    void this.storage.update(STORAGE_PREFIX + prKey, raw)
  }

  /** Drops the pull requests that were not touched for the longest time */
  prune(): void {
    const entries: { key: string; updatedAt: number }[] = []
    for (const key of this.storage.keys()) {
      if (!key.startsWith(STORAGE_PREFIX)) continue
      const parsed = storedSchema.safeParse(this.storage.get(key))
      entries.push({ key, updatedAt: parsed.success ? parsed.data.updatedAt : 0 })
    }
    if (entries.length <= MAX_STORED_PRS) return

    entries.sort((a, b) => b.updatedAt - a.updatedAt)
    for (const entry of entries.slice(MAX_STORED_PRS)) {
      void this.storage.update(entry.key, undefined)
    }
  }
}
