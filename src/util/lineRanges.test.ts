import { expect, test } from 'vitest'
import {
  countLines,
  intersectRanges,
  mapRanges,
  normalizeRanges,
  rangesOfLines,
  subtractRanges,
  unionRanges,
} from './lineRanges'

const r = (start: number, end: number) => ({ start, end })

test('normalize sorts and merges ranges that overlap or touch', () => {
  expect(normalizeRanges([r(8, 9), r(1, 3), r(4, 5), r(2, 2), r(7, 6)])).toEqual([
    r(1, 5),
    r(8, 9),
  ])
})

test('union, intersection and difference', () => {
  expect(unionRanges([r(1, 2)], [r(3, 4), r(10, 10)])).toEqual([r(1, 4), r(10, 10)])
  expect(intersectRanges([r(1, 5), r(8, 12)], [r(4, 9), r(12, 20)])).toEqual([
    r(4, 5),
    r(8, 9),
    r(12, 12),
  ])
  expect(subtractRanges([r(1, 10)], [r(3, 4), r(6, 6), r(10, 12)])).toEqual([
    r(1, 2),
    r(5, 5),
    r(7, 9),
  ])
  expect(subtractRanges([r(1, 3)], [r(0, 5)])).toEqual([])
})

test('counts the lines without counting overlaps twice', () => {
  expect(countLines([r(1, 3), r(2, 4), r(10, 10)])).toBe(5)
})

test('builds ranges from single lines', () => {
  expect(rangesOfLines([5, 1, 2, 3, 7])).toEqual([r(1, 3), r(5, 5), r(7, 7)])
})

test('maps the lines and drops the ones without a place', () => {
  const map = (line: number) => (line === 3 ? undefined : line + 10)
  expect(mapRanges([r(1, 5)], map)).toEqual([r(11, 12), r(14, 15)])
})
