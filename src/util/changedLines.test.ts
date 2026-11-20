import { expect, test } from 'vitest'
import { applyReviewedLines, changedLinesBetween, isBinaryText } from './changedLines'

const r = (start: number, end: number) => ({ start, end })

test('finds the added lines and the deletions of the new version', () => {
  const before = 'a\nb\nc\nd\ne\n'
  const after = 'a\nB\nc\ne\nf\n'
  expect(changedLinesBetween(before, after)).toEqual({
    added: [r(2, 2), r(5, 5)],
    deletionAnchors: [4],
  })
})

test('every line of a new file is added', () => {
  expect(changedLinesBetween('', 'a\nb\n')).toEqual({
    added: [r(1, 2)],
    deletionAnchors: [],
  })
})

test('a deletion at the end is anchored to the last line', () => {
  expect(changedLinesBetween('a\nb\n', 'a\n')).toEqual({ added: [], deletionAnchors: [1] })
})

test('a removed line that is replaced is a modification, not a deletion', () => {
  expect(changedLinesBetween('a\nb\nc\n', 'a\nB\nc\n')).toEqual({
    added: [r(2, 2)],
    deletionAnchors: [],
  })
})

test('applying no reviewed lines gives the old version', () => {
  expect(applyReviewedLines('a\nb\n', 'a\nB\n', [])).toBe('a\nb\n')
})

test('applying all changed lines gives the new version', () => {
  const before = 'a\nb\nc\nd\ne\n'
  const after = 'a\nB\nc\ne\nf\n'
  expect(applyReviewedLines(before, after, [r(1, 5)])).toBe(after)
})

test('applies only the reviewed changes', () => {
  const before = 'a\nb\nc\nd\ne\n'
  const after = 'a\nB\nc\ne\nf\n'
  // B is reviewed, the deletion of d (anchored to e) and f are not
  expect(applyReviewedLines(before, after, [r(2, 2)])).toBe('a\nB\nc\nd\ne\n')
  // the deletion of d is reviewed
  expect(applyReviewedLines(before, after, [r(4, 4)])).toBe('a\nb\nc\ne\n')
})

test('a partly reviewed change keeps its removed lines', () => {
  const before = 'a\nold\nz\n'
  const after = 'a\nnew 1\nnew 2\nz\n'
  expect(applyReviewedLines(before, after, [r(2, 2)])).toBe('a\nold\nnew 1\nz\n')
  expect(applyReviewedLines(before, after, [r(2, 3)])).toBe(after)
})

test('keeps the line endings of the new version', () => {
  expect(applyReviewedLines('a\r\n', 'a\r\nb\r\n', [r(2, 2)])).toBe('a\r\nb\r\n')
})

test('recognizes binary content', () => {
  expect(isBinaryText('PNG\u0000\u0001')).toBe(true)
  expect(isBinaryText('text')).toBe(false)
})
