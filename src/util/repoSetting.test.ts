import { expect, test } from 'vitest'
import { namesOf, withNames } from './repoSetting'

test('finds the names of a repository, whatever the case of its key', () => {
  const setting = { 'Acme/App': ['Beta Feature', ' bug ', ' '], 'acme/lib': ['x'] }

  expect(namesOf(setting, 'acme/app')).toEqual(['Beta Feature', 'bug'])
  expect(namesOf(setting, 'acme/other')).toEqual([])
})

test('replaces the names of a repository and keeps the other repositories', () => {
  const setting = { 'Acme/App': ['a'], 'acme/lib': ['x'] }

  expect(withNames(setting, 'acme/app', ['b', 'c'])).toEqual({
    'Acme/App': ['b', 'c'],
    'acme/lib': ['x'],
  })
  expect(withNames(setting, 'acme/new', ['n'])).toEqual({
    'Acme/App': ['a'],
    'acme/lib': ['x'],
    'acme/new': ['n'],
  })
})

test('removes a repository that has no names anymore', () => {
  expect(withNames({ 'acme/app': ['a'], 'acme/lib': ['x'] }, 'acme/app', [])).toEqual({
    'acme/lib': ['x'],
  })
})
