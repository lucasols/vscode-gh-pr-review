import type { LineRange } from './patch'

/** Sorts the ranges and merges the ones that overlap or touch */
export function normalizeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = ranges
    .filter((range) => range.end >= range.start)
    .toSorted((a, b) => a.start - b.start)
  const result: LineRange[] = []
  for (const range of sorted) {
    const last = result.at(-1)
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
    } else {
      result.push({ start: range.start, end: range.end })
    }
  }
  return result
}

export function unionRanges(a: readonly LineRange[], b: readonly LineRange[]): LineRange[] {
  return normalizeRanges([...a, ...b])
}

export function intersectRanges(
  a: readonly LineRange[],
  b: readonly LineRange[],
): LineRange[] {
  const left = normalizeRanges(a)
  const right = normalizeRanges(b)
  const result: LineRange[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const x = left[i]
    const y = right[j]
    if (!x || !y) break
    const start = Math.max(x.start, y.start)
    const end = Math.min(x.end, y.end)
    if (start <= end) result.push({ start, end })
    if (x.end < y.end) i++
    else j++
  }
  return result
}

/** The lines of `a` that are not in `b` */
export function subtractRanges(
  a: readonly LineRange[],
  b: readonly LineRange[],
): LineRange[] {
  const removed = normalizeRanges(b)
  const result: LineRange[] = []
  for (const range of normalizeRanges(a)) {
    let start = range.start
    for (const cut of removed) {
      if (cut.end < start || cut.start > range.end) continue
      if (cut.start > start) result.push({ start, end: cut.start - 1 })
      start = cut.end + 1
    }
    if (start <= range.end) result.push({ start, end: range.end })
  }
  return result
}

export function countLines(ranges: readonly LineRange[]): number {
  return normalizeRanges(ranges).reduce((sum, range) => sum + range.end - range.start + 1, 0)
}

export function rangesOfLines(lines: Iterable<number>): LineRange[] {
  return normalizeRanges([...lines].map((line) => ({ start: line, end: line })))
}

/** Moves every line to where `map` puts it, dropping the lines that it has no place for */
export function mapRanges(
  ranges: readonly LineRange[],
  map: (line: number) => number | undefined,
): LineRange[] {
  const lines: number[] = []
  for (const range of normalizeRanges(ranges)) {
    for (let line = range.start; line <= range.end; line++) {
      const mapped = map(line)
      if (mapped !== undefined) lines.push(mapped)
    }
  }
  return rangesOfLines(lines)
}
