import { z } from 'zod'
import type { Baseline } from '../model/baselines'
import { REMOVED_BLOB, type PrDetail, type PrFile } from '../model/types'

/**
 * Identifies a version of a file of a pull request. It is stored in the query
 * of the URI of the document, so a document can always be traced back to the
 * pull request and the content it shows.
 */
const docRefSchema = z.object({
  /** `owner/name` */
  repo: z.string(),
  pr: z.number(),
  /** Path of the file in the pull request */
  path: z.string(),
  /**
   * `base` and `head` are the two sides of the diff of the pull request,
   * `viewed` is the version that was marked as viewed, `commit` is the version
   * of a chosen commit and `empty` stands for a file that does not exist.
   */
  side: z.enum(['base', 'head', 'viewed', 'commit', 'empty']),
  /** Content addressed by git blob */
  blob: z.string().optional(),
  /** Content addressed by the path in a commit */
  commit: z.string().optional(),
  srcPath: z.string().optional(),
})

export type DocRef = z.infer<typeof docRefSchema>

export function encodeDocRef(ref: DocRef): string {
  // a fixed key order, so that the same version always gives the same URI
  return JSON.stringify({
    repo: ref.repo,
    pr: ref.pr,
    path: ref.path,
    side: ref.side,
    blob: ref.blob,
    commit: ref.commit,
    srcPath: ref.srcPath,
  })
}

export function decodeDocRef(query: string): DocRef | undefined {
  let json: unknown
  try {
    json = JSON.parse(query)
  } catch {
    return undefined
  }
  const parsed = docRefSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

export function docRefPrKey(ref: DocRef): string {
  return `${ref.repo}#${ref.pr}`
}

function base(detail: PrDetail, file: PrFile): Pick<DocRef, 'repo' | 'pr' | 'path'> {
  return { repo: detail.summary.repo, pr: detail.summary.number, path: file.path }
}

/** The version of the file in the head commit of the pull request */
export function headDocRef(detail: PrDetail, file: PrFile): DocRef {
  if (file.status === 'removed') return { ...base(detail, file), side: 'empty' }
  if (file.blobSha) return { ...base(detail, file), side: 'head', blob: file.blobSha }
  return {
    ...base(detail, file),
    side: 'head',
    commit: detail.summary.headRefOid,
    srcPath: file.path,
  }
}

/** The version of the file that the pull request started from */
export function baseDocRef(detail: PrDetail, file: PrFile): DocRef {
  if (file.status === 'added') return { ...base(detail, file), side: 'empty' }
  return {
    ...base(detail, file),
    side: 'base',
    commit: detail.mergeBaseOid,
    srcPath: file.previousPath ?? file.path,
  }
}

/** The version of the file that was marked as viewed */
export function viewedDocRef(detail: PrDetail, file: PrFile, baseline: Baseline): DocRef {
  if (baseline.blob === REMOVED_BLOB) return { ...base(detail, file), side: 'empty' }
  return { ...base(detail, file), side: 'viewed', blob: baseline.blob }
}

/** The version of the file in a commit of the pull request */
export function commitDocRef(detail: PrDetail, file: PrFile, commit: string): DocRef {
  return { ...base(detail, file), side: 'commit', commit, srcPath: file.path }
}
