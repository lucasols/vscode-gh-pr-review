import { z } from 'zod'
import type { ContentService } from '../content/contentService'
import { baseDocRef, headDocRef, viewedDocRef, type DocRef } from '../content/docRef'
import { errorMessage } from '../util/async'
import {
  applyReviewedLines,
  changedLinesBetween,
  isBinaryText,
  type ChangedLines,
} from '../util/changedLines'
import { Emitter } from '../util/emitter'
import { createLineMapper } from '../util/lineMap'
import {
  countLines,
  intersectRanges,
  mapRanges,
  rangesOfLines,
  subtractRanges,
  unionRanges,
} from '../util/lineRanges'
import type { LineRange } from '../util/patch'
import { isChangedSinceViewed, type Baseline } from './baselines'
import { PrRecordStore, type RecordStorage } from './prRecordStore'
import { summaryKey, type PrDetail, type PrFile } from './types'

const recordSchema = z.object({
  /** The git blob of the head version that the lines are numbered in */
  blob: z.string(),
  /** The lines that were reviewed (1-based, inclusive) */
  lines: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
  at: z.number(),
})

export type LineReviewRecord = z.infer<typeof recordSchema>

/** Keeps the reviewed lines of the files of each pull request */
export class LineReviewStore extends PrRecordStore<LineReviewRecord> {
  constructor(storage: RecordStorage) {
    super(storage, 'lineReviews:v1:', recordSchema)
  }
}

/** The review of the changed lines of the current head version of a file */
export type FileLineReview = {
  /** The git blob of the head version that the lines are numbered in */
  blob: string
  /** The lines to review: the added lines and the deletion anchors */
  changed: LineRange[]
  /** Lines next to a place where lines were only deleted */
  deletionAnchors: number[]
  /** The changed lines that were reviewed */
  reviewed: LineRange[]
  total: number
  reviewedCount: number
}

export function unreviewedLines(review: FileLineReview): LineRange[] {
  return subtractRanges(review.changed, review.reviewed)
}

export function isFullyReviewed(review: FileLineReview): boolean {
  return review.reviewedCount >= review.total
}

type Plan = {
  prKey: string
  path: string
  headBlob: string
  head: DocRef
  /** Identifies the changed lines of the head version */
  changedKey: string
  /** The version that the review starts from */
  before: DocRef
  record: LineReviewRecord | undefined
  /** Identifies the reviewed lines of the record moved to the head version */
  carriedKey: string | undefined
}

type Known<T> = { value: T }

function withoutFinished(
  records: Readonly<Record<string, LineReviewRecord>>,
  detail: PrDetail,
): Record<string, LineReviewRecord> {
  const files = new Map(detail.files.map((item) => [item.path, item]))
  const next: Record<string, LineReviewRecord> = {}
  for (const [path, record] of Object.entries(records)) {
    const file = files.get(path)
    if (file && file.viewedState !== 'VIEWED') next[path] = record
  }
  return next
}

const CACHE_LIMIT = 500

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size <= CACHE_LIMIT) return
  const oldest = cache.keys().next()
  if (!oldest.done) cache.delete(oldest.value)
}

/**
 * Tracks which changed lines of each file were reviewed, so that a file can
 * be reviewed in several sittings before it is marked as viewed. Like staged
 * lines in git: the diffs compare the head version with the `reviewed`
 * version, which has the reviewed changes applied, so they show only what is
 * left to review.
 *
 * The lines to review are the changes that a click on the file shows: the
 * changes since the file was viewed when it changed after that (and that diff
 * is the default), the whole diff of the pull request otherwise. The reviewed
 * lines are stored with the blob that they are numbered in. After a push they
 * are moved to the new version, and the lines that changed are not reviewed
 * anymore.
 */
export class LineReviews {
  private readonly emitter = new Emitter<string>()
  /** Fires with the key of the pull request whose reviewed lines changed */
  readonly onDidChange = this.emitter.event

  private readonly changedCache = new Map<string, ChangedLines | null>()
  private readonly carriedCache = new Map<string, LineRange[]>()
  private readonly jobs = new Map<string, Promise<void>>()

  constructor(
    private readonly deps: {
      records: LineReviewStore
      content: Pick<ContentService, 'readText'>
      /** Whether a file that changed after it was viewed shows only those changes */
      preferSinceViewed: () => boolean
      now: () => number
      log: (message: string) => void
    },
  ) {}

  /** Whether some lines of the file were reviewed, in any version */
  hasReviewedLines(prKey: string, path: string): boolean {
    return this.deps.records.get(prKey)[path] !== undefined
  }

  /**
   * The review of the lines of a file. Undefined when the file has no lines to
   * review one by one (it is viewed, removed or binary), and while what is
   * needed is loaded, after which `onDidChange` fires.
   */
  get(
    detail: PrDetail,
    file: PrFile,
    baseline: Baseline | undefined,
  ): FileLineReview | undefined {
    const plan = this.plan(detail, file, baseline)
    if (!plan) return undefined
    const changed = this.changedOf(plan)
    const carried = this.carriedOf(plan)
    if (changed instanceof Promise || carried instanceof Promise) return undefined
    return this.build(plan, changed.value, carried.value)
  }

  /** Like `get`, but waits for what is loaded */
  async load(
    detail: PrDetail,
    file: PrFile,
    baseline: Baseline | undefined,
  ): Promise<FileLineReview | undefined> {
    const plan = this.plan(detail, file, baseline)
    if (!plan) return undefined
    const changed = this.changedOf(plan)
    const carried = this.carriedOf(plan)
    await Promise.all([changed, carried])
    return this.get(detail, file, baseline)
  }

  /**
   * The version that the review started from, with the reviewed changes
   * applied. It is the head version once the file is viewed.
   */
  async reviewedText(
    detail: PrDetail,
    file: PrFile,
    baseline: Baseline | undefined,
  ): Promise<string> {
    const plan = this.plan(detail, file, baseline)
    if (!plan) return this.deps.content.readText(headDocRef(detail, file))
    const [before, after, review] = await Promise.all([
      this.deps.content.readText(plan.before),
      this.deps.content.readText(plan.head),
      this.load(detail, file, baseline),
    ])
    return review ? applyReviewedLines(before, after, review.reviewed) : before
  }

  /**
   * Marks lines of the head version as reviewed or not. Lines that are not
   * changed are ignored. Returns the review after the change.
   */
  async setReviewed(
    detail: PrDetail,
    file: PrFile,
    baseline: Baseline | undefined,
    ranges: readonly LineRange[],
    reviewed: boolean,
  ): Promise<FileLineReview | undefined> {
    const current = await this.load(detail, file, baseline)
    if (!current) return undefined

    const lines =
      reviewed ?
        unionRanges(current.reviewed, intersectRanges(ranges, current.changed))
      : subtractRanges(current.reviewed, ranges)

    const prKey = summaryKey(detail.summary)
    const now = this.deps.now()
    const records = withoutFinished(this.deps.records.get(prKey), detail)

    if (lines.length === 0) delete records[file.path]
    else records[file.path] = { blob: current.blob, lines, at: now }
    this.deps.records.set(prKey, records, now)
    this.emitter.fire(prKey)

    return this.get(detail, file, baseline)
  }

  /**
   * Forgets the reviewed lines of the files that are viewed, so they are fully
   * reviewed, and of the files that left the pull request. Pass what GitHub
   * confirmed: a file that is being marked as viewed can stay not viewed.
   */
  forgetFinished(detail: PrDetail): void {
    const prKey = summaryKey(detail.summary)
    const records = this.deps.records.get(prKey)
    const next = withoutFinished(records, detail)
    if (Object.keys(next).length === Object.keys(records).length) return
    this.deps.records.set(prKey, next, this.deps.now())
    this.emitter.fire(prKey)
  }

  private plan(
    detail: PrDetail,
    file: PrFile,
    baseline: Baseline | undefined,
  ): Plan | undefined {
    const headBlob = file.blobSha
    if (file.viewedState === 'VIEWED' || file.status === 'removed' || !headBlob) {
      return undefined
    }

    const prKey = summaryKey(detail.summary)
    const head: DocRef = {
      repo: detail.summary.repo,
      pr: detail.summary.number,
      path: file.path,
      side: 'head',
      blob: headBlob,
    }

    let changedKey: string
    let before: DocRef
    if (this.deps.preferSinceViewed() && isChangedSinceViewed(file, baseline)) {
      before = viewedDocRef(detail, file, baseline)
      changedKey = `${headBlob}<viewed:${baseline.blob}`
    } else {
      before = baseDocRef(detail, file)
      changedKey = `${headBlob}<base:${detail.mergeBaseOid}:${file.previousPath ?? file.path}`
    }

    const record = this.deps.records.get(prKey)[file.path]
    const carriedKey =
      record && record.blob !== headBlob ?
        `${prKey}|${file.path}|${record.blob}@${record.at}>${headBlob}`
      : undefined

    return {
      prKey,
      path: file.path,
      headBlob,
      head,
      changedKey,
      before,
      record,
      carriedKey,
    }
  }

  private changedOf(plan: Plan): Known<ChangedLines | null> | Promise<void> {
    const cached = this.changedCache.get(plan.changedKey)
    if (cached !== undefined) return { value: cached }

    return this.run(plan.changedKey, plan.prKey, async () => {
      let value: ChangedLines | null
      try {
        const [before, after] = await Promise.all([
          this.deps.content.readText(plan.before),
          this.deps.content.readText(plan.head),
        ])
        value =
          isBinaryText(before) || isBinaryText(after) ? null : changedLinesBetween(before, after)
      } catch (error) {
        this.deps.log(`Could not compare the versions of ${plan.path}: ${errorMessage(error)}`)
        value = null
      }
      remember(this.changedCache, plan.changedKey, value)
    })
  }

  private carriedOf(plan: Plan): Known<LineRange[]> | Promise<void> {
    const { record, carriedKey } = plan
    if (!record) return { value: [] }
    if (carriedKey === undefined) return { value: record.lines }

    const cached = this.carriedCache.get(carriedKey)
    if (cached !== undefined) return { value: cached }

    return this.run(carriedKey, plan.prKey, async () => {
      let value: LineRange[]
      try {
        const [before, after] = await Promise.all([
          this.deps.content.readText({ ...plan.head, blob: record.blob }),
          this.deps.content.readText(plan.head),
        ])
        value = mapRanges(record.lines, createLineMapper(before, after).toTarget)
      } catch (error) {
        this.deps.log(
          `Could not move the reviewed lines of ${plan.path} to the new version: ${errorMessage(error)}`,
        )
        value = []
      }
      remember(this.carriedCache, carriedKey, value)
    })
  }

  private run(key: string, prKey: string, task: () => Promise<void>): Promise<void> {
    let job = this.jobs.get(key)
    if (!job) {
      job = task().finally(() => {
        this.jobs.delete(key)
        this.emitter.fire(prKey)
      })
      this.jobs.set(key, job)
    }
    return job
  }

  private build(
    plan: Plan,
    changedLines: ChangedLines | null,
    carried: readonly LineRange[],
  ): FileLineReview | undefined {
    if (!changedLines) return undefined
    const changed = unionRanges(
      changedLines.added,
      rangesOfLines(changedLines.deletionAnchors),
    )
    const total = countLines(changed)
    if (total === 0) return undefined

    const reviewed = intersectRanges(carried, changed)
    return {
      blob: plan.headBlob,
      changed,
      deletionAnchors: changedLines.deletionAnchors,
      reviewed,
      total,
      reviewedCount: countLines(reviewed),
    }
  }

  dispose(): void {
    this.emitter.dispose()
  }
}
