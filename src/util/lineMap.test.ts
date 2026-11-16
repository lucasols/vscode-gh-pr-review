import { expect, test } from 'vitest'
import { createLineMapper } from './lineMap'

test('identical texts map every line to itself', () => {
  const mapper = createLineMapper('a\nb\nc', 'a\nb\nc')
  expect(mapper.identical).toBe(true)
  expect(mapper.toTarget(2)).toBe(2)
  expect(mapper.toSource(3)).toBe(3)
})

test('lines after an insertion are shifted', () => {
  const mapper = createLineMapper('a\nb\nc', 'a\nnew 1\nnew 2\nb\nc')
  expect(mapper.identical).toBe(false)
  expect(mapper.toTarget(1)).toBe(1)
  expect(mapper.toTarget(2)).toBe(4)
  expect(mapper.toTarget(3)).toBe(5)
  expect(mapper.toSource(2)).toBeUndefined()
  expect(mapper.toSource(3)).toBeUndefined()
  expect(mapper.toSource(4)).toBe(2)
})

test('removed and changed lines have no mapping', () => {
  const mapper = createLineMapper('a\nb\nc\nd', 'a\nc\nD')
  expect(mapper.toTarget(1)).toBe(1)
  expect(mapper.toTarget(2)).toBeUndefined()
  expect(mapper.toTarget(3)).toBe(2)
  expect(mapper.toTarget(4)).toBeUndefined()
  expect(mapper.toSource(3)).toBeUndefined()
})

test('line endings do not count as a change', () => {
  const mapper = createLineMapper('a\nb\nc', 'a\r\nx\r\nb\r\nc')
  expect(mapper.toTarget(2)).toBe(3)
  expect(mapper.toTarget(3)).toBe(4)
})
