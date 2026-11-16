export type LineRange = { start: number; end: number }

export type PatchLines = {
  /** Lines of the base version that are part of the diff (1-based, inclusive) */
  left: LineRange[]
  /** Lines of the head version that are part of the diff (1-based, inclusive) */
  right: LineRange[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * GitHub only accepts review comments on lines that are inside a hunk of the
 * diff, so the hunks of the patch tell which lines can be commented.
 */
export function parsePatchLines(patch: string | undefined): PatchLines {
  const result: PatchLines = { left: [], right: [] }
  if (!patch) return result

  for (const line of patch.split('\n')) {
    const match = HUNK_HEADER.exec(line)
    if (!match) continue

    const leftStart = Number(match[1])
    const leftCount = match[2] === undefined ? 1 : Number(match[2])
    const rightStart = Number(match[3])
    const rightCount = match[4] === undefined ? 1 : Number(match[4])

    if (leftCount > 0) {
      result.left.push({ start: leftStart, end: leftStart + leftCount - 1 })
    }
    if (rightCount > 0) {
      result.right.push({ start: rightStart, end: rightStart + rightCount - 1 })
    }
  }

  return result
}

export function isLineInRanges(line: number, ranges: readonly LineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end)
}
