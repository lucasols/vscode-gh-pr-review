import { expect, test } from 'vitest'
import { isLineInRanges, parsePatchLines } from './patch'

test('reads the commentable lines of each side from the hunks', () => {
  const patch = [
    '@@ -15,6 +15,9 @@ RUN pnpm install --frozen-lockfile --prod',
    ' ',
    ' FROM node:26.12.1-slim AS production',
    '+# comment',
    '+RUN apt-get update',
    '+RUN python3 -c',
    ' WORKDIR /usr/src/app',
    '@@ -40 +43,2 @@',
    '-old',
    '+new',
    '+newer',
  ].join('\n')

  expect(parsePatchLines(patch)).toEqual({
    left: [
      { start: 15, end: 20 },
      { start: 40, end: 40 },
    ],
    right: [
      { start: 15, end: 23 },
      { start: 43, end: 44 },
    ],
  })
})

test('an added file has no commentable lines on the left', () => {
  expect(parsePatchLines('@@ -0,0 +1,3 @@\n+a\n+b\n+c')).toEqual({
    left: [],
    right: [{ start: 1, end: 3 }],
  })
})

test('a removed file has no commentable lines on the right', () => {
  expect(parsePatchLines('@@ -1,2 +0,0 @@\n-a\n-b')).toEqual({
    left: [{ start: 1, end: 2 }],
    right: [],
  })
})

test('a missing patch (binary or too large) has no commentable lines', () => {
  expect(parsePatchLines(undefined)).toEqual({ left: [], right: [] })
})

test('a line of the content that looks like a hunk header is not a hunk', () => {
  expect(parsePatchLines('@@ -1,2 +1,2 @@\n-@@ -9,9 +9,9 @@\n+x\n y').right).toEqual([
    { start: 1, end: 2 },
  ])
})

test('isLineInRanges', () => {
  const ranges = [{ start: 3, end: 5 }]
  expect(isLineInRanges(2, ranges)).toBe(false)
  expect(isLineInRanges(3, ranges)).toBe(true)
  expect(isLineInRanges(5, ranges)).toBe(true)
  expect(isLineInRanges(6, ranges)).toBe(false)
})
