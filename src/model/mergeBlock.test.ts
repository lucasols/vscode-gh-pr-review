import { describe, expect, test } from 'vitest'
import { getMergeBlock } from './mergeBlock'

type Input = Parameters<typeof getMergeBlock>[0]

function input(
  overview: Partial<Input['overview']> = {},
  summary: Partial<Input['summary']> = {},
): Input {
  return {
    summary: { state: 'OPEN', isDraft: false, ...summary },
    overview: {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      allowedMergeMethods: ['SQUASH'],
      viewerCanMerge: true,
      viewerCanMergeAsAdmin: false,
      ...overview,
    },
  }
}

describe('getMergeBlock', () => {
  test('a pull request that meets its requirements can be merged', () => {
    expect(getMergeBlock(input())).toBeUndefined()
    expect(getMergeBlock(input({ mergeStateStatus: 'HAS_HOOKS' }))).toBeUndefined()
  })

  test('a check that is not required does not block the merge', () => {
    expect(getMergeBlock(input({ mergeStateStatus: 'UNSTABLE' }))).toBeUndefined()
  })

  test('the rules of the base branch block the merge', () => {
    expect(getMergeBlock(input({ mergeStateStatus: 'BLOCKED' }))).toEqual({
      kind: 'rules',
      reason: 'Merging is blocked by the rules of the base branch',
      canBypass: false,
    })
    expect(getMergeBlock(input({ mergeStateStatus: 'BEHIND' }))).toEqual({
      kind: 'rules',
      reason: 'This branch is out of date with the base branch',
      canBypass: false,
    })
  })

  test('an admin can bypass the rules, but nothing else', () => {
    const admin = { viewerCanMergeAsAdmin: true }
    expect(getMergeBlock(input({ ...admin, mergeStateStatus: 'BLOCKED' }))?.canBypass).toBe(true)
    expect(getMergeBlock(input({ ...admin, mergeStateStatus: 'BEHIND' }))?.canBypass).toBe(true)
    expect(
      getMergeBlock(input({ ...admin, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })),
    ).toMatchObject({ kind: 'conflicts', canBypass: false })
    expect(getMergeBlock(input(admin, { isDraft: true }))).toMatchObject({
      kind: 'draft',
      canBypass: false,
    })
  })

  test('conflicts block the merge', () => {
    expect(
      getMergeBlock(input({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }))?.kind,
    ).toBe('conflicts')
  })

  test('the merge waits while GitHub computes if the branch can be merged', () => {
    expect(
      getMergeBlock(input({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))?.kind,
    ).toBe('checking')
  })

  test('a viewer without write access cannot merge', () => {
    expect(getMergeBlock(input({ viewerCanMerge: false }))?.kind).toBe('permission')
  })

  test('a repository without merge methods cannot merge', () => {
    expect(getMergeBlock(input({ allowedMergeMethods: [] }))?.kind).toBe('noMethod')
  })

  test('a pull request that is not open cannot be merged', () => {
    expect(getMergeBlock(input({}, { state: 'MERGED' }))?.kind).toBe('closed')
    expect(getMergeBlock(input({}, { state: 'CLOSED' }))?.kind).toBe('closed')
  })
})
