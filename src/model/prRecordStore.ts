import { z } from 'zod'

export type RecordStorage = {
  keys: () => readonly string[]
  get: (key: string) => unknown
  update: (key: string, value: unknown) => PromiseLike<void>
}

const MAX_STORED_PRS = 300

/**
 * Keeps a record per file of each pull request in the storage of the
 * extension, which is shared with the other windows.
 */
export class PrRecordStore<T> {
  /**
   * The parsed value of each stored entry. The storage is shared with the
   * other windows, which can replace an entry at any time, so a parsed value
   * is only reused while the stored value is still the same object.
   */
  private readonly cache = new Map<string, { raw: unknown; files: Record<string, T> }>()
  private readonly storedSchema: z.ZodType<{ updatedAt: number; files: Record<string, T> }>

  constructor(
    private readonly storage: RecordStorage,
    private readonly prefix: string,
    recordSchema: z.ZodType<T>,
  ) {
    this.storedSchema = z.object({
      updatedAt: z.number(),
      files: z.record(z.string(), recordSchema),
    })
  }

  get(prKey: string): Record<string, T> {
    const raw = this.storage.get(this.prefix + prKey)
    const cached = this.cache.get(prKey)
    if (cached && cached.raw === raw) return cached.files

    const parsed = this.storedSchema.safeParse(raw)
    const files = parsed.success ? parsed.data.files : {}
    this.cache.set(prKey, { raw, files })
    return files
  }

  set(prKey: string, files: Record<string, T>, now: number): void {
    const isEmpty = Object.keys(files).length === 0
    const raw = isEmpty ? undefined : { updatedAt: now, files }
    this.cache.set(prKey, { raw, files })
    void this.storage.update(this.prefix + prKey, raw)
  }

  /** Drops the pull requests that were not touched for the longest time */
  prune(): void {
    const entries: { key: string; updatedAt: number }[] = []
    for (const key of this.storage.keys()) {
      if (!key.startsWith(this.prefix)) continue
      const parsed = this.storedSchema.safeParse(this.storage.get(key))
      entries.push({ key, updatedAt: parsed.success ? parsed.data.updatedAt : 0 })
    }
    if (entries.length <= MAX_STORED_PRS) return

    entries.sort((a, b) => b.updatedAt - a.updatedAt)
    for (const entry of entries.slice(MAX_STORED_PRS)) {
      void this.storage.update(entry.key, undefined)
    }
  }
}
