import { diffArrays } from 'diff'
import { isLineInRanges, type LineRange } from './patch'
import { rangesOfLines } from './lineRanges'

/** The lines of the new version of a file that a review has to look at */
export type ChangedLines = {
  /** Lines (1-based) that were added or modified */
  added: LineRange[]
  /**
   * Lines next to a place where lines were only deleted: the line after the
   * deletion, or the line before it at the end of the file.
   */
  deletionAnchors: number[]
}

type Block =
  | { kind: 'same'; lines: string[] }
  | {
      kind: 'change'
      removed: string[]
      added: string[]
      /** The line of the new version where the added lines start */
      start: number
      /** For a deletion without added lines, the line that stands for it */
      anchor: number | undefined
    }

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** The diff of two versions, with each run of removed and added lines as one change */
function diffBlocks(before: string, after: string): Block[] {
  const afterLines = splitLines(after)
  const blocks: Block[] = []
  let target = 1
  let change: Extract<Block, { kind: 'change' }> | undefined

  const closeChange = () => {
    if (!change) return
    if (change.added.length === 0) {
      if (target <= afterLines.length) change.anchor = target
      else if (target > 1) change.anchor = target - 1
    }
    blocks.push(change)
    change = undefined
  }

  for (const part of diffArrays(splitLines(before), afterLines)) {
    if (!part.added && !part.removed) {
      closeChange()
      blocks.push({ kind: 'same', lines: part.value })
      target += part.value.length
      continue
    }
    change ??= { kind: 'change', removed: [], added: [], start: target, anchor: undefined }
    if (part.added) {
      change.added.push(...part.value)
      target += part.value.length
    } else {
      change.removed.push(...part.value)
    }
  }
  closeChange()
  return blocks
}

/** The changed lines of the new version, from the content of both versions */
export function changedLinesBetween(before: string, after: string): ChangedLines {
  const added: number[] = []
  const anchors: number[] = []
  for (const block of diffBlocks(before, after)) {
    if (block.kind !== 'change') continue
    for (let i = 0; i < block.added.length; i++) added.push(block.start + i)
    if (block.anchor !== undefined) anchors.push(block.anchor)
  }
  const addedSet = new Set(added)
  return {
    added: rangesOfLines(added),
    deletionAnchors: [...new Set(anchors)]
      .filter((line) => !addedSet.has(line))
      .toSorted((a, b) => a - b),
  }
}

/**
 * The old version with the reviewed changes of the new version applied, like
 * the index of git with staged lines. A diff against the new version then
 * shows only what is left to review.
 *
 * A change keeps its removed lines until all of its added lines are reviewed.
 * A deletion is applied when its anchor line is reviewed.
 */
export function applyReviewedLines(
  before: string,
  after: string,
  reviewed: readonly LineRange[],
): string {
  if (reviewed.length === 0) return before

  const lines: string[] = []
  for (const block of diffBlocks(before, after)) {
    if (block.kind === 'same') {
      lines.push(...block.lines)
      continue
    }
    if (block.added.length === 0) {
      const applied = block.anchor !== undefined && isLineInRanges(block.anchor, reviewed)
      if (!applied) lines.push(...block.removed)
      continue
    }
    const accepted = block.added.filter((_, i) => isLineInRanges(block.start + i, reviewed))
    if (accepted.length < block.added.length) lines.push(...block.removed)
    lines.push(...accepted)
  }

  const eol = after.includes('\r\n') ? '\r\n' : '\n'
  const finalEol = lines.length > 0 && /\n$/.test(after) ? eol : ''
  return lines.join(eol) + finalEol
}

/** Whether the content looks like a binary file, whose lines mean nothing */
export function isBinaryText(text: string): boolean {
  return text.includes('\u0000')
}
