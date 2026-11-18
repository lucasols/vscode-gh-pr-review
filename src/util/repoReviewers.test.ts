import { expect, test } from 'vitest'
import { reviewersOf } from './repoReviewers'

test('finds the reviewers of a repository, whatever the case and with or without @', () => {
  const setting = { 'Acme/App': ['Ana', '@bruno', ' '], 'acme/lib': ['x'] }

  expect([...(reviewersOf(setting, 'acme/app') ?? [])]).toEqual(['ana', 'bruno'])
})

test('a repository that is not in the setting, or has an empty list, is not limited', () => {
  expect(reviewersOf({ 'acme/lib': ['x'] }, 'acme/app')).toBeUndefined()
  expect(reviewersOf({ 'acme/app': [] }, 'acme/app')).toBeUndefined()
})
