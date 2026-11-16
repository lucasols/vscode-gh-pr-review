import { expect, test } from 'vitest'
import { parseGitHubRemote } from './remoteUrl'

test('parses the common GitHub remote formats', () => {
  const expected = { owner: 'lucasols', name: 'vscode-gh-pr-review' }
  expect(parseGitHubRemote('https://github.com/lucasols/vscode-gh-pr-review.git')).toEqual(
    expected,
  )
  expect(parseGitHubRemote('https://github.com/lucasols/vscode-gh-pr-review')).toEqual(
    expected,
  )
  expect(
    parseGitHubRemote('https://user:token@github.com/lucasols/vscode-gh-pr-review/'),
  ).toEqual(expected)
  expect(parseGitHubRemote('git@github.com:lucasols/vscode-gh-pr-review.git')).toEqual(
    expected,
  )
  expect(
    parseGitHubRemote('ssh://git@github.com/lucasols/vscode-gh-pr-review.git'),
  ).toEqual(expected)
  expect(
    parseGitHubRemote('ssh://git@ssh.github.com:443/lucasols/vscode-gh-pr-review.git'),
  ).toEqual(expected)
  expect(parseGitHubRemote('git@github-work:lucasols/vscode-gh-pr-review.git')).toEqual(
    expected,
  )
})

test('keeps dots in the repository name', () => {
  expect(parseGitHubRemote('git@github.com:owner/my.repo.git')).toEqual({
    owner: 'owner',
    name: 'my.repo',
  })
})

test('rejects other hosts and malformed URLs', () => {
  expect(parseGitHubRemote('https://gitlab.com/owner/repo.git')).toBeUndefined()
  expect(parseGitHubRemote('git@bitbucket.org:owner/repo.git')).toBeUndefined()
  expect(parseGitHubRemote('https://github.com/owner')).toBeUndefined()
  expect(parseGitHubRemote('https://github.com/owner/repo/extra')).toBeUndefined()
  expect(parseGitHubRemote('/local/path/repo')).toBeUndefined()
  expect(parseGitHubRemote('')).toBeUndefined()
})
