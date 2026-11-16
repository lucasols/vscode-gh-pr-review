import { expect, test } from 'vitest'
import { reviewersOf, withReviewers } from './repoReviewers'

test('finds the reviewers of a repository, whatever the case and with or without @', () => {
  const setting = { 'Acme/App': ['Ana', '@bruno', ' '], 'acme/lib': ['x'] }

  expect([...(reviewersOf(setting, 'acme/app') ?? [])]).toEqual(['ana', 'bruno'])
})

test('a repository that is not in the setting, or has an empty list, is not limited', () => {
  expect(reviewersOf({ 'acme/lib': ['x'] }, 'acme/app')).toBeUndefined()
  expect(reviewersOf({ 'acme/app': [] }, 'acme/app')).toBeUndefined()
})

test('replaces the reviewers of a repository and keeps the other repositories', () => {
  const setting = { 'Acme/App': ['a'], 'acme/lib': ['x'] }

  expect(withReviewers(setting, 'acme/app', ['b', 'c'])).toEqual({
    'Acme/App': ['b', 'c'],
    'acme/lib': ['x'],
  })
  expect(withReviewers(setting, 'acme/new', ['n'])).toEqual({
    'Acme/App': ['a'],
    'acme/lib': ['x'],
    'acme/new': ['n'],
  })
})

test('removes a repository that has no reviewers anymore', () => {
  expect(withReviewers({ 'acme/app': ['a'], 'acme/lib': ['x'] }, 'acme/app', [])).toEqual({
    'acme/lib': ['x'],
  })
})
